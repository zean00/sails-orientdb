var Oriento = require('oriento'),
    Q = require('q'),
    async = require('async'),
    _ = require('underscore');

module.exports = (function () {

    'use strict';

    var defaults = {
            createCustomIndex: false,
            idProperty: 'id'
        },
        server, transformers = {
            '@rid': function (rid) {
                return '#' + rid.cluster + ':' + rid.position;
            }
        },
        dbHelper = function (db, collections, config) {
            this.db = db;
            this.collections = collections;
            this.config = _.extend(config, defaults);
        },
        ensureDB = function (database) {
            var deferred = Q.defer();
            server.list().then(function (dbs) {
                var dbExists = _.find(dbs, function (db) {
                    return database.name === database.name;
                });
                if (dbExists) {
                    deferred.resolve(server.use(database));
                } else {
                    server.create(database).then(function (db) {
                        deferred.resolve(db);
                    });
                }


            });

            return deferred.promise;
        },
        getDb = function (connection) {


            if (!server)
                server = Oriento(connection);

            return ensureDB(connection.database);

        };

    dbHelper.prototype.db = null;
    dbHelper.prototype.collections = null;
    dbHelper.prototype.config = null;
    dbHelper.prototype._classes = null;

    dbHelper.prototype.getClass = function (collection) {
        return this._classes[collection];
    };


    dbHelper.prototype.ensureIndex = function () {
        var deferred = Q.defer(),
            db = this.db,
            idProp = this.config.idProperty,
            indexName = 'V.' + idProp;

        async.auto({
                getVClass: function (next, results) {

                    db.class.get('V')
                        .then(function (klass, err) {
                            next(err, klass);
                        });
                },
                getProps: ['getVClass',
                        function (next, results) {
                        var klass = results.getVClass;
                        klass.property.list()
                            .then(function (properties, err) {
                                next(err, properties);
                            });
                }],
                getIdProp: ['getProps',
                    function (next, results) {
                        var klass = results.getVClass,
                            properties = results.getProps,
                            prop = _.findWhere(properties, {
                                name: idProp
                            });

                        if (!prop) {
                            klass.property.create({
                                name: idProp,
                                type: 'String'
                            }).then(function (property, err) {
                                next(err, property);
                            });
                            return;
                        }
                        next(null, prop);
                        }],
                ensureIndex: ['getIdProp',
                    function (next, results) {

                        var createIndex = function (err) {
                            if (err) {
                                db.index.create({
                                    name: indexName,
                                    type: 'unique'
                                }).then(function (index, err) {
                                    next(err, true);
                                });
                                return;
                            }
                        };

                        db.index.get(indexName)
                            .error(createIndex)
                            .done(function (index, err) {
                                //if index not found then create it
                                index && next(err, true);
                            });

                            }]



            },
            function (err, results) {
                if (err) {
                    deferred.reject(err);
                    return;
                }
                deferred.resolve(results);
            });
        return deferred.promise;

    };

    /*Makes sure that all the collections are synced to database classes*/
    dbHelper.prototype.registerCollections = function () {
        var deferred = Q.defer(),
            me = this,
            //TODO: Register collections
            db = me.db,
            collections = this.collections;

        async.auto({
            ensureIndex: function (next, results) {
                if (me.config.createCustomIndex) {
                    me.ensureIndex().then(function (indexEnsured, err) {
                        next(err, indexEnsured);
                    });
                    return;
                }
                next(err, me.config.createCustomIndex);
            },
            getClasses: ['ensureIndex',
             function (next, results) {

                    db.class.list().then(function (classes, err) {
                        next(err, classes);
                    });
            }],
            registerClasses: ['getClasses',
                function (complete, results) {
                    var classes = results.getClasses,
                        klassesToBeAdded = _.filter(collections, function (v, k) {
                            return _.find(classes, function (klass) {
                                return k == klass.name;
                            }) == null;
                        });

                    if (klassesToBeAdded.length > 0) {

                        async.mapSeries(klassesToBeAdded, function (collection, next) {

                            db.class
                                .create(collection.tableName, 'V')
                                .then(function (klass, err) {
                                    next(err, klass);
                                });

                        }, function (err, created) {

                            //TODO: create edges and handle migration

                            complete(err, created);
                        });
                        return;
                    }
                    complete(null, classes);

            }]
        }, function (err, results) {
            if (err) {
                deferred.reject(err);
                return;
            }

            //flatten the array of classes to key value pairs to ease the retrieval of classes
            me._classes = _.reduce(results.registerClasses, function (initial, klass) {

                var collection = _.find(me.collections, function (v, k) {
                    return v.tableName === klass.name;
                });
                //If a matching collection is found then store the class reference using the collection name else use class name itself
                initial[(collection && collection.identity) || klass.name] = klass;
                return initial;
            }, {});

            deferred.resolve(results.registerClasses);
        });
        return deferred.promise;
    };
    /*Query methods starts from here*/

    dbHelper.prototype.find = function (collection, options, cb) {

        var query = this.db.select().from(collection);

        if (options.where)
            query = query
            .where(options.where);

        query.transform(transformers);

        if (options.limit)
            query = query
            .limit(options.limit);
        query
            .all()
            .then(function (res) {
                cb(null, res);
            })
            .error(function (err) {
                cb(err);
            });

    };

    //Deletes a collection from database
    dbHelper.prototype.drop = function (collection, relations, cb) {

        return db.exec('drop class :name', {
                params: {
                    name: collection
                }
            })
            .then(function (res) {
                cb(null, res);
            })
            .error(function (err) {
                cb(err);
            });

    };

    /*
    Creates a new document from a collection
    */
    dbHelper.prototype.create = function (collection, options, cb) {

        //TODO: automatically associate collection refrences using edges

        this.db.insert()
            .into(collection)
            .set(options)
            .transform(transformers)
            .one()
            .then(function (res) {
                cb(null, res);
            }).error(function (err) {
                cb(err);
            });


    };

    /*
    Updates a document from a collection
    */
    dbHelper.prototype.update = function (collection, options, values, cb) {

        this.db
            .update(collection)
            .set(values)
            .where(options)
            .transform(transformers)
            .then(function (total) {
                cb(null, total);
            }).error(function (err) {
                cb(err);
            });
    };

    /*
    Deletes a document from a collection
    */
    dbHelper.prototype.destroy = function (collection, options, values, cb) {

        this.db.delete()
            .from(collection)
            .where(options)
            .transform(transformers)
            .scalar()
            .then(function (total) {
                cb(null, total);
            })
            .error(function (err) {
                cb(err);
            });

    };



    var connect = function (connection, collections) {
        // if an active connection exists, use
        // it instead of tearing the previous
        // one down
        var d = Q.defer();

        try {

            getDb(connection, collections).then(function (db) {
                var helper = new dbHelper(db, collections, connection);

                helper.registerCollections()
                    .then(function (classes, err) {
                        d.resolve(helper);
                    });

            });

        } catch (err) {
            console.log('An error has occured when trying to connect to OrientDB:');
            d.reject(err);
            throw err;
        }



        return d.promise;

    };


    return {
        create: function (connection, collections) {
            return connect(connection, collections);
        }
    };

})();