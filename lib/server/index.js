"use strict";

const pjson = require("../../package.json");
const configHelper = require("../config");
// const short = require('short-uuid');
const ShortUniqueId = require('short-unique-id');
const uid = new ShortUniqueId({ length: 8 });
const { config } = configHelper;
global.exitOnUncaught = config.exitOnUncaught;

const Raven = require("raven");
const ravenConfig = require("../util/raven-config");
if (config.sentry && config.sentry.enabled) {
	Raven.config(config.sentry.dsn, ravenConfig).install();
	global.sentryEnabled = true;

	process.on("unhandledRejection", (reason, p) => {
		console.error("Unhandled Rejection at:", p, "reason:", reason);
		Raven.captureException(reason);
	});

	console.info("[nodecg] Sentry enabled.");
}

// Native
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

// Packages
const bodyParser = require("body-parser");
const clone = require("clone");
const debounce = require("lodash.debounce");
const express = require("express");
const fetch = require("make-fetch-happen");
const semver = require("semver");
const template = require("lodash.template");
const memoize = require("fast-memoize");
const transformMiddleware =
	require("express-transform-bare-module-specifiers").default;

// Ours
const bundleManager = require("../bundle-manager");
const Logger = require("../logger");
const tokens = require("../login/tokens");
const UnauthorizedError = require("../login/UnauthorizedError");
const { short } = require("git-rev-sync");

const log = new Logger("nodecg/lib/server");
const authorizedSockets = {};
let app;
let server;
let io;
let extensionManager;

// PROJECTS ADDON
// const projects = require('../projects');

// ADDON END

// Check for updates
fetch("http://registry.npmjs.org/nodecg/latest")
	.then((res) => {
		return res.json(); // Download the body as JSON
	})
	.then((body) => {
		if (semver.gt(body.version, pjson.version) >= 1) {
			log.warn(
				"An update is available for NodeCG: %s (current: %s)",
				JSON.parse(body).version,
				pjson.version
			);
		}
	})
	.catch(
		/* istanbul ignore next */ () => {
			// Discard errors.
		}
	);

const renderTemplate = memoize((content, options) => {
	return template(content)(options);
});

module.exports = new EventEmitter();

module.exports.start = function () {
	log.info(
		"Starting NodeCG %s (Running on Node.js %s)",
		pjson.version,
		process.version
	);

	// (Re)create Express app, HTTP(S) & Socket.IO servers
	app = express();

	if (global.sentryEnabled) {
		app.use(Raven.requestHandler());
		app.use(Raven.errorHandler());
	}

	if (config.ssl && config.ssl.enabled) {
		const sslOpts = {
			key: fs.readFileSync(config.ssl.keyPath),
			cert: fs.readFileSync(config.ssl.certificatePath),
		};
		if (config.ssl.passphrase) {
			sslOpts.passphrase = config.ssl.passphrase;
		}

		// If we allow HTTP on the same port, use httpolyglot
		// otherwise, standard https server
		server = config.ssl.allowHTTP
			? require("httpolyglot").createServer(sslOpts, app)
			: require("https").createServer(sslOpts, app);
	} else {
		server = require("http").createServer(app);
	}

	io = require("socket.io")(server);
	io.sockets.setMaxListeners(64); // Prevent console warnings when many extensions are installed

	// Set up Express
	log.trace("Setting up Express");
	app.use(require("compression")());
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));

	app.engine("tmpl", (filePath, options, callback) => {
		fs.readFile(filePath, (error, content) => {
			if (error) {
				return callback(error);
			}

			return callback(null, renderTemplate(content, options));
		});
	});

	if (config.login && config.login.enabled) {
		log.info("Login security enabled");
		const login = require("../login");
		app.use(login);
		io.use(tokens.authorize());
	} else {
		app.get("/login*", (req, res) => {
			res.redirect("/dashboard");
		});
	}

	const bundlesPaths = [path.join(process.env.NODECG_ROOT, "bundles")].concat(
		config.bundles.paths
	);
	const cfgPath = path.join(process.env.NODECG_ROOT, "cfg");

	if (global.isZeitPkg) {
		bundlesPaths.unshift(path.resolve(__dirname, "../../bundles"));
	}

	const dashboardTransformRootDir = path.resolve(__dirname, "../..");
	app.use(
		"/node_modules/*",
		transformMiddleware({
			rootDir: path.join(dashboardTransformRootDir, "node_modules"),
			modulesUrl: "/node_modules",
		})
	);

	app.use(
		"/dashboard/*",
		transformMiddleware({
			rootDir: path.join(dashboardTransformRootDir, "src"),
			modulesUrl: "/node_modules",
		})
	);

	bundleManager.init(bundlesPaths, cfgPath, pjson.version, config, Logger);

	bundleManager.all().forEach((bundle) => {
		if (bundle.transformBareModuleSpecifiers) {
			const opts = {
				rootDir: global.isZeitPkg
					? path.resolve(__dirname, "../../")
					: process.env.NODECG_ROOT,
				modulesUrl: `/bundles/${bundle.name}/node_modules`,
			};
			app.use(`/bundles/${bundle.name}/*`, transformMiddleware(opts));
		}
	});

	// DB CONFIG
	var Datastore = require("nedb");
	var projectPath = path.join(process.env.NODECG_ROOT, "/db/projects.db");
	var db = new Datastore({ filename: projectPath, autoload: true });
	db.ensureIndex({ fieldName: "nedb" }, function (err) {
		if (err) return console.log(err);
	});
	const cors = require("cors");
	app.use(cors());
// 	// CLEAN UP TEMP FOLDER ON STARTUP!
	
// var tempFolder = path.join(
// 	process.env.NODECG_ROOT,
// 	"/assets/temp"
// );
// console.log('Running Cleanup on', tempFolder)
// if (fs.existsSync(tempFolder)) {
// 	fs.readdir(tempFolder, (err, folders) => {
// if (err) console.log("error is: ", err)
// 		// CHECK  IF FILE EXISTS
// 	// console.log("Folders are: ", folders)

// 		for (var i = 0; i < folders.length; ++i) {
// var currentFolder = folders[i]
// 			fs.readdir(path.join(tempFolder, folders[i]), (deepError, files) => {
// 				if (deepError) console.log("deepError is: ", deepError)
// // console.log("files are: ", files)
// for (var k = 0; k < files.length; ++k) {
// console.log("Removed File: ", files[k], "from", currentFolder)
// var fileFullPath = path.join(tempFolder, currentFolder, files[k] )
// // console.log("full folder is: ", path.join(tempFolder, currentFolder, files[k] ))
// fs.unlink(fileFullPath, function(err){
// 	if(err) return console.log(err);
// 	// console.log('file deleted successfully');


// 							  })

// }
// 			})

// 		}
			
	
	
// })

// } else {
// mkdirp.sync(tempFolder)
// }
// console.log('Cleanup Done.')

// GET ALL PROJECTS
app.get("/test", async (req, res) => {
	console.log("hello")
	res.send("helllo")
});


// GET ALL PROJECTS
app.get("/projects", async (req, res) => {
	db.find({}, function (err, docs) {
		if (err) {
			// console.log("err: ", err)
			res.send(err.toString());
		} else {
			if (docs) {
				const allDocs = [];
				for (var i = 0; i < docs.length; ++i) {
					// console.log(`${i} name is: ${docs[i].name}`)
					allDocs.push({ name: docs[i].name, id: docs[i]._id });
					if (i === docs.length - 1) {
						res.send(allDocs);
					}
				}
			} else {
				res.send("There are no projects!");
			}
		}
	});
});


	// MULTER CONFIG
	const shortid = require("shortid");
	const multer = require("multer");
	const mkdirp = require("mkdirp");
	const randomName = shortid.generate();
const MAX_CG_FILES = 1;
const CG_LIMIT_FILE_SIZE = 1000000000;
const cgAllowedTypes = [
  "image/jpeg",
  "image/png", 
  "video/mp4",
  "video/webm"
];
const MAX_BOX_FILES = 1;
const BOX_LIMIT_FILE_SIZE = 1000000000;
const boxAllowedTypes = [
  "image/jpeg",
  "image/png", 
  "video/mp4"
];
const MAX_PROMO_FILES = 1;
const PROMO_LIMIT_FILE_SIZE = 1000000000;
const promoAllowedTypes = [
  "image/jpeg",
  "image/png", 
  "video/mp4"
];

// ==============CG============================
// CG FileFilter

const cgfileFilter = async (req, file, cb) => {
	if (!cgAllowedTypes.includes(file.mimetype)) {
	  const error = new Error("Wrong File type");
	  error.code = "CG_LIMIT_FILE_TYPES";
	  return cb(error, false);
	}
  
	cb(null, true);
  };
  
  // CG Multer Storage Settings
  const cgstorage = multer.diskStorage({
	destination: async (req, file, cb) => {
	  const projectName = req.params.projectname;
	  if(projectName === 'temp') {
		const path = `./assets/temp/cg`;
		mkdirp.sync(path);
		cb(null, path);
	  } else {
		const path = `./assets/${projectName}/cg`;
		mkdirp.sync(path);
		cb(null, path);
	  }
	  
	
	},
	filename: async (req, file, cb) => {
	  const cgReceiveFileName =
		randomName + "-" + Date.now() + "-" + file.originalname;
	  cb(null, cgReceiveFileName);
	},
  });
  
  // CG Multer Upload Settings
  const uploadCG = multer({
	storage: cgstorage,
	fileFilter: cgfileFilter,
	limits: {
	  fileSize: CG_LIMIT_FILE_SIZE,
	},
  }).array("cg", MAX_CG_FILES);
  // ============== CG END ===============

  app.use(function (err, req, res, next) {
	if (err.code === "CG_LIMIT_FILE_TYPES") {
	  res.status(422).json({ error: `MP4, Webm, PNG or JPEG are allowed!` });
	  return;
	}
	if (err.code === "CG_LIMIT_FILE_SIZE") {
	  res.status(422).json({
		error: `Too large. Max size allowed ${CG_LIMIT_FILE_SIZE / 1000000}`,
	  });
	  return;
	}

})
  // CG Post Handler
app.post("/:projectname/cg", uploadCG, async (req, res, next) => {
	// if(req.params.projectName === 'temp') {
	// 	console.log("temp happend")
	// }
	// const projectName = req.params.projectName;
	res.json(req.files);
	// for (var i = 0; i < req.files.length; i++) {
	//   term.brightBlue(`CG was uploaded: `) +
	// 	term.bold(`${req.files[i].destination}` + `/${req.files[i].filename}\n`);
	// }
	res.send();
	

	// var projectCheck = 
	// if(projectId) {

	// } else [

	// ]

  });

  // ==============BOX============================
// BOX FileFilter

const boxfileFilter = async (req, file, cb) => {
	if (!boxAllowedTypes.includes(file.mimetype)) {
	  const error = new Error("Wrong File type");
	  error.code = "BOX_LIMIT_FILE_TYPES";
	  return cb(error, false);
	}
  
	cb(null, true);
  };
  
  // BOX Multer Storage Settings
  const boxstorage = multer.diskStorage({
	destination: async (req, file, cb) => {
	  const projectName = req.params.projectname;
	  if(projectName === 'temp') {
		const path = `./assets/temp/box`;
		mkdirp.sync(path);
		cb(null, path);
	  } else {
		const path = `./assets/${projectName}/box`;
		mkdirp.sync(path);
		cb(null, path);
	  }
	  
	
	},
	filename: async (req, file, cb) => {
	  const boxReceiveFileName =
		randomName + "-" + Date.now() + "-" + file.originalname;
	  cb(null, boxReceiveFileName);
	},
  });
  
  // BOX Multer Upload Settings
  const uploadBox = multer({
	storage: boxstorage,
	fileFilter: boxfileFilter,
	limits: {
	  fileSize: BOX_LIMIT_FILE_SIZE,
	},
  }).array("box", MAX_BOX_FILES);
  // ============== BOX END ===============

  app.use(function (err, req, res, next) {
	if (err.code === "BOX_LIMIT_FILE_TYPES") {
	  res.status(422).json({ error: `MP4, PNG or JPEG are allowed!` });
	  return;
	}
	if (err.code === "BOX_LIMIT_FILE_SIZE") {
	  res.status(422).json({
		error: `Too large. Max size allowed ${BOX_LIMIT_FILE_SIZE / 1000000}`,
	  });
	  return;
	}

})
  // BOX Post Handler
app.post("/:projectname/box", uploadBox, async (req, res, next) => {
	// if(req.params.projectName === 'temp') {
	// 	console.log("temp happend")
	// }
	// const projectName = req.params.projectName;
	res.json(req.files);
	// for (var i = 0; i < req.files.length; i++) {
	//   term.brightBlue(`Box was uploaded: `) +
	// 	term.bold(`${req.files[i].destination}` + `/${req.files[i].filename}\n`);
	// }
	res.send();
	

	// var projectCheck = 
	// if(projectId) {

	// } else [

	// ]

  });

  // ==============PROMO============================
// PROMO FileFilter

const promofileFilter = async (req, file, cb) => {
	if (!promoAllowedTypes.includes(file.mimetype)) {
	  const error = new Error("Wrong File type");
	  error.code = "PROMO_LIMIT_FILE_TYPES";
	  return cb(error, false);
	}
  
	cb(null, true);
  };
  
  // PROMO Multer Storage Settings
  const promostorage = multer.diskStorage({
	destination: async (req, file, cb) => {
	  const projectName = req.params.projectname;
	  if(projectName === 'temp') {
		const path = `./assets/temp/promo`;
		mkdirp.sync(path);
		cb(null, path);
	  } else {
		const path = `./assets/${projectName}/promo`;
		mkdirp.sync(path);
		cb(null, path);
	  }
	  
	
	},
	filename: async (req, file, cb) => {
	  const promoReceiveFileName =
		randomName + "-" + Date.now() + "-" + file.originalname;
	  cb(null, promoReceiveFileName);
	},
  });
  
  // PROMO Multer Upload Settings
  const uploadPromo = multer({
	storage: promostorage,
	fileFilter: promofileFilter,
	limits: {
	  fileSize: PROMO_LIMIT_FILE_SIZE,
	},
  }).array("promo", MAX_PROMO_FILES);
  // ============== PROMO END ===============

  app.use(function (err, req, res, next) {
	if (err.code === "PROMO_LIMIT_FILE_TYPES") {
	  res.status(422).json({ error: `MP4, PNG or JPEG are allowed!` });
	  return;
	}
	if (err.code === "PROMO_LIMIT_FILE_SIZE") {
	  res.status(422).json({
		error: `Too large. Max size allowed ${PROMO_LIMIT_FILE_SIZE / 1000000}`,
	  });
	  return;
	}

})
  // PROMO Post Handler
app.post("/:projectname/promo", uploadPromo, async (req, res, next) => {
	// if(req.params.projectName === 'temp') {
	// 	console.log("temp happend")
	// }
	// const projectName = req.params.projectName;
	res.json(req.files);
	// for (var i = 0; i < req.files.length; i++) {
	//   term.brightBlue(`Promo was uploaded: `) +
	// 	term.bold(`${req.files[i].destination}` + `/${req.files[i].filename}\n`);
	// }
	res.send();
	

  });
	// CREATE PROJECT
	app.post("/project/create/:name", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var overwrite = false;
		var items = []
		if (req.body.overwrite) {
			overwrite = true;
			if(req.params.items && req.params.items.length > 0) {
				var items = req.params.items
			} else {
				var items = []
				var item = {
					index: 0,
					name: "Ex. First Item",
					expanded: true,
					options: false,
					elements: [],
					uid: uid()
				};
				items.push(item);
			}
			var name = req.params.name;
		}
		
		var name = req.params.name;
		// console.log("name is:", name)
		if (name && name !== "undefined") {
			db.find({}, function (err, docs) {
				if (err) {
					res.send(err.toString());
				} else {
					if (docs.length > 50) {
						res.send(
							`Maximum is 50 projects, please remove some to add new!`
						);
					} else {
						// var check = false
						if (docs) {
							for (var i = 0; i < docs.length; ++i) {
                                // console.log("project is: :", docs[i].name)
								
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								if (
									docs[i].name.toLowerCase() ===
										name.toLowerCase() &&
									!overwrite
								) {
									res.send(`Name exists!`);
									break;
								} else {
									if (i === docs.length - 1) {
										// var project = []
										if (req.body.items) {
											// console.log("passed project")
											var project = {
												name: req.params.name,
												// index: docs.length,
												items: req.body.items,
												files: []
												// settings
												// font
											};
											// var project = 
										} else {
											// console.log("at else")
											var project = {
												name: req.params.name,
												// index: docs.length,
												items: [],
												files: []
												// settings
												// font
											};

											var item = {
												index: 0,
												name: "Ex. First Item",
												expanded: true,
												options: false,
												elements: [],
												uid: uid()
											};
											project.items.push(item);
										}

										// console.log("pushing project is: ", project)
										if(overwrite) {
											// console.log("I'm at overwrite, id to replace is: ", docs[i]._id)

											db.update(
												{ _id: docs[i]._id },
												// { $set: { name: newName } },
										
												{ $set:  {items: items }},
												function (err, numUpdated) {
													if (err) {
														// console.log("err: ", err)
														res.send(err);
													} else {
														if (numUpdated > 0) {
															res.send(numUpdated.toString());
														} else {
															res.send("Didn't update");
														}
													}
													// db.findOne({ _id: id }, function (err, updatedDoc) {
								
													// });
												}
											);
										} else {
										db.insert(
											project,
											function (err, newDoc) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													res.send(newDoc);
												}
											}
										);
										}
									}
								}
							}
							if (docs.length === 0) {
								if (req.body.items) {
									// console.log("passed project");
									var project = {
										name: req.params.name,
										// index: docs.length,
										items: req.body.items,
										files: []
										// settings
										// font
									};
								} else {
									// console.log("at else");
									var project = {
										name: req.params.name,
										// index: docs.length,
										items: [],
										files: []
										// settings
										// font
									};

									var item = {
										index: 0,
										name: "Ex. First Item",
										expanded: true,
										options: false,
										elements: [],
										uid: uid()
									};
									project.items.push(item);
								}

								// console.log("pushing project is: ", project)
								db.insert(project, function (err, newDoc) {
									if (err) {
										// console.log("err: ", err)
										res.send(err.toString());
									} else {
										res.send(`${newDoc}`);
									}
								});
							}
						} else {
							res.send(`Project ${id} doesn't Exist`);
						}
					}
				}
			});
		} else {
			res.send(`Basic Parameters are undefined`);
		}
	});

	// VALIDATE PROJECT EXISTANCE
	app.get("/project/prompt/:name", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		const name = req.params.name;
		// db.find({ _id: id }, function (err, docs) {
		// 	if (docs.length === 0) {
		// 		return res.send(false);
		// 	} else {
		// 		return res.send(docs);
		// 	}
		// });

		db.find({}, function (err, docs) {
			// if (err) console.log("err: ", err)
			if (err) {
				// console.log("err: ", err)
				res.send(err.toString());
			} else {
				if (docs) {
					for (var i = 0; i < docs.length; ++i) {
						if (docs[i].name.toLowerCase() === name.toLowerCase()) {
							res.send(true);
							break;
						} else {
							if (i === docs.length - 1) {
								res.send(false);
							}
						}
					}
				} else {
					res.send(`Project ${id} doesn't Exist`);
				}
			}

			// }
		});
	});

	// GET PROJECT
	app.get("/project/:id", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		const id = req.params.id;
		if (id && id !== "undefined") {
			db.findOne({ _id: id }, function (err, docs) {
				if (err) {
					// console.log("err: ", err);
					res.send(err.toString());
				} else {
					if (docs) {
						if (docs.name) {
							return res.send(docs);
						} else {
							return res.send(false);
						}
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	


	io.on("error", (err) => {
		if (global.sentryEnabled) {
			Raven.captureException(err);
		}

		log.error(err.stack);
	});

	io.on("connection", (socket) => {
		log.trace(
			"New socket connection: ID %s with IP %s",
			socket.id,
			socket.handshake.address
		);

		socket.on("error", (err) => {
			if (global.sentryEnabled) {
				Raven.captureException(err);
			}

			log.error(err.stack);
		});

		socket.on("message", (data) => {
			log.debug("Socket %s sent a message:", socket.id, data);
			io.emit("message", data);
		});

		socket.on("joinRoom", (room, cb) => {
			if (typeof room !== "string") {
				throw new Error("Room must be a string");
			}

			if (Object.keys(socket.rooms).indexOf(room) < 0) {
				log.trace("Socket %s joined room:", socket.id, room);
				socket.join(room);
			}

			if (typeof cb === "function") {
				cb();
			}
		});

		if (config.login && config.login.enabled) {
			const { token } = socket;
			if (!{}.hasOwnProperty.call(authorizedSockets, token)) {
				authorizedSockets[token] = [];
			}

			if (authorizedSockets[token].indexOf(socket) < 0) {
				authorizedSockets[token].push(socket);
			}

			socket.on("disconnect", () => {
				// Sockets for this token might have already been invalidated
				if ({}.hasOwnProperty.call(authorizedSockets, token)) {
					const idx = authorizedSockets[token].indexOf(socket);
					if (idx >= 0) {
						authorizedSockets[token].splice(idx, 1);
					}
				}
			});

			socket.on("regenerateToken", (token, cb) => {
				log.debug("Socket %s requested a new token:", socket.id);
				cb = cb || function () {};

				tokens.regenerate(token, (err, newToken) => {
					if (err) {
						log.error(err.stack);
						cb(err);
						return;
					}

					cb(null, newToken);

					function invalidate() {
						// Disconnect all sockets using this token
						if (Array.isArray(authorizedSockets[token])) {
							const sockets = authorizedSockets[token].slice(0);
							sockets.forEach((socket) => {
								socket.error(
									new UnauthorizedError("token_invalidated", {
										message:
											"This token has been invalidated",
									}).data
								);

								socket.disconnect(true);
							});
						}
					}

					// TODO: Why is this on a timeout? If it's really needed, explain why.
					setTimeout(invalidate, 500);
				});
			});
		}
	});

	log.trace(`Attempting to listen on ${config.host}:${process.env.PORT || 80}`);
	server.on("error", (err) => {
		switch (err.code) {
			case "EADDRINUSE":
				if (process.env.NODECG_TEST) {
					return;
				}

				log.error(
					`[server.js] Listen ${config.host}:${process.env.PORT || 80} in use, is NodeCG already running? NodeCG will now exit.`
				);
				break;
			default:
				log.error("Unhandled error!", err);
				break;
		}

		module.exports.emit("error", err);
	});

	log.trace("Starting graphics lib");
	const graphics = require("../graphics");
	app.use(graphics);

	log.trace("Starting dashboard lib");
	const dashboard = require("../dashboard");
	app.use(dashboard);

	log.trace("Starting mounts lib");
	const mounts = require("../mounts");
	app.use(mounts);

	log.trace("Starting bundle sounds lib");
	const sounds = require("../sounds");
	app.use(sounds);

	log.trace("Starting bundle assets lib");
	const assets = require("../assets");
	app.use(assets);

	log.trace("Starting bundle shared sources lib");
	const sharedSources = require("../shared-sources");
	app.use(sharedSources);

	// Set up "bundles" Replicant.
	const Replicant = require("../replicant");
	const bundlesReplicant = new Replicant("bundles", "nodecg", {
		schemaPath: path.resolve(__dirname, "../../schemas/bundles.json"),
		persistent: false,
	});
	const updateBundlesReplicant = debounce(() => {
		bundlesReplicant.value = clone(bundleManager.all());
	}, 100);
	bundleManager.on("init", updateBundlesReplicant);
	bundleManager.on("bundleChanged", updateBundlesReplicant);
	bundleManager.on("gitChanged", updateBundlesReplicant);
	bundleManager.on("bundleRemoved", updateBundlesReplicant);
	updateBundlesReplicant();

	extensionManager = require("./extensions.js");
	extensionManager.init();
	module.exports.emit("extensionsLoaded");

	// We intentionally wait until all bundles and extensions are loaded before starting the server.
	// This has two benefits:
	// 1) Prevents the dashboard/views from being opened before everything has finished loading
	// 2) Prevents dashboard/views from re-declaring replicants on reconnect before extensions have had a chance
	server.listen(
		{
			host: config.host,
			port: process.env.NODECG_TEST ? undefined : process.env.PORT || 80,
		},
		() => {
			if (process.env.NODECG_TEST) {
				const { port } = server.address();
				log.warn(
					`Test mode active, using automatic listen port: ${process.env.PORT || 80}`
				);
				configHelper.config.port = process.env.PORT || 80;
				configHelper.filteredConfig.port = process.env.PORT || 80;
				process.env.NODECG_TEST_PORT = process.env.PORT || 80;
			}

			const protocol =
				config.ssl && config.ssl.enabled ? "https" : "http";
			log.info("NodeCG running on %s://%s", protocol, config.baseURL);
			module.exports.emit("started");
		}
	);
};

module.exports.stop = function () {
	if (server) {
		server.close();
	}

	if (io) {
		io.close();
	}

	require("../replicator").saveAllReplicants();

	extensionManager = null;
	io = null;
	server = null;
	app = null;

	module.exports.emit("stopped");
};

module.exports.getExtensions = function () {
	/* istanbul ignore else */
	if (extensionManager) {
		return extensionManager.getExtensions();
	}

	/* istanbul ignore next */
	return {};
};

module.exports.getIO = function () {
	return io;
};

module.exports.mount = function (...args) {
	app.use(...args);
};
