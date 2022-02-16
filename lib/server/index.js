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

	// RENAME PROJECT BY ID
	app.post("/project/:id/rename", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var id = req.params.id;
		var newName = req.body.newName;
		if (id && id !== "undefined" && newName && newName !== "undefined") {
			db.update(
				{ _id: id },
				{ $set: { name: newName } },
				{},
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
			res.send("Basic Parameters are undefined!");
		}
	});

	// DELETE SPECIFIC PROJECT
	app.delete("/project/:id", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var id = req.params.id;
		if (id && id !== "undefined") {
			db.remove({ _id: id }, {}, function (err, numRemoved) {
				// console.log("num removed is: ", numRemoved)
				if (err) {
					// console.log("err: ", err)
					res.send(err.toString());
				} else {
					if (numRemoved > 0) {
						res.send(numRemoved.toString());
					} else {
						res.send("Didn't update");
					}
				}
				// });
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// CREATE NEW ITEM
	app.post("/project/:id/item", async (req, res) => {
		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		if (selectedItem === null || selectedItem === undefined) {
			selectedItem = 0;
		}
		if (id && id !== "undefined") {
			db.findOne({ _id: id }, function (err, docs) {
				if (err) {
					res.send(err.toString());
				} else {
					if (docs) {
						// console.log("found in db: ", docs.length)
						// const indexing =
						if (docs.name) {
							var items = docs.items;
							const itemTemplate = {
								index: null,
								name: "New Example Item",
								expanded: true,
								options: false,
								elements: [],
								uid: uid()
							};

							items.splice(selectedItem, 0, itemTemplate);
							// console.log("sending items: ", newArray)
							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, updatedDoc) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (updatedDoc) {
													// console.log("updated doc is: ",updatedDoc)
													res.send(
														updatedDoc.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
											// db.findOne({ _id: id }, function (err, updatedDoc) {

											// });
										}
									);
								}
							}
							if (items.length === 0) {
								db.update(
									{ _id: id },
									{ $set: { items: items } },
									{},
									function (err, updatedDoc) {
										if (err) {
											// console.log("err: ", err)
											res.send(err.toString());
										} else {
											if (updatedDoc) {
												res.send(updatedDoc.toString());
											} else {
												res.send("Didn't update");
											}
										}
									}
								);
							}
						} else {
							res.send("Document name is undefined!");
						}

						// console.log("selected item is: ", docs.items[selectedItem])

						// db.insert(indexedItem, function (err, newDoc) {
						// 	res.send("done");
						// });
						// res.send(docs)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// UPDATE ITEM NAME
	app.put("/project/:id/itemname", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var newName = req.body.name;
		// console.log("id is: ", id)
		// console.log("index is: ", index)
		// console.log("newName is: ", newName)
		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			newName &&
			newName !== "undefined"
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							items[selectedItem].name = newName;
							// console.log("updated docs name is: ", items[index].name)
							// newDocs.elements[index].name = newName;
							// const newArray = newDocs.elements;

							db.update(
								{ _id: id },
								{ $set: { items: items } },
								{},
								function (err, numUpdated) {
									if (err) {
										// console.log("err: ", err);
										res.send(err.toString());
									} else {
										if (numUpdated > 0) {
											res.send(numUpdated.toString());
										} else {
											res.send("Didn't update");
										}
									}
								}
							);
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		// var index = req.body.index;

		// } else {
		// 	// FILE DOESN't EXIST!
		// 	res.send(false);
		// }
		// }
		// });
	});

	// DELETE SPECIFIC ITEM
	app.post("/project/:id/deleteitem", async (req, res) => {
		// 	console.log("REQ BODY: ", req.body);
		//   console.log("REQ PARAMS: ", req.params);
		var id = req.params.id;
		var selectedItem = req.body.selectedItem;

		if (id && id !== "undefined" && !isNaN(selectedItem)) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							items.splice(selectedItem, 1);
							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
							if (items.length === 0) {
								res.send("Not found");
								// db.update(
								// 	{ _id: id },
								// 	{ $set: { items: items } },
								// 	{},
								// 	function (err, numUpdated) {
								// 		if (err) console.log("err: ", err)
								// 		// db.findOne({ _id: id }, function (err, updatedDoc) {
								// 		res.send(200);
								// 		// });
								// 	}
								// );
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ITEM UP
	app.put("/project/:id/item/up", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
	
		function array_move(arr, fromIndex) {
			var element = arr[fromIndex];
			arr.splice(fromIndex, 1);
			arr.splice(fromIndex - 1, 0, element);
		}

		if (id && id !== "undefined" && !isNaN(selectedItem)) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						// var preIndexCheck =
						if (selectedItem > 0) {
							// items.splice(selectedItem, 1);
							array_move(items, selectedItem);
							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ITEM DOWN
	app.put("/project/:id/item/down", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;

		function array_move(arr, fromIndex) {
			var element = arr[fromIndex];
			arr.splice(fromIndex, 1);
			arr.splice(fromIndex + 1, 0, element);
		}

		if (id && id !== "undefined" && !isNaN(selectedItem)) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						if (selectedItem <= preIndexCheck) {
							// items.splice(selectedItem, 1);
							array_move(items, selectedItem);
							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ITEM
	app.put("/project/:id/item/move", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var fromItem = req.body.fromItem;
		var toItem = req.body.toItem;
		// console.log("moving from: ", fromSelectedItem, ". to: ", toSelectedItem)
		// var item = req.body.item;

	

		if (id && id !== "undefined" && !isNaN(fromItem) && !isNaN(toItem)) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						
						// // // .splice(from, 1);
						// console.log("newArray is: ", items.length);
						// console.log("item test2 is name: ", items[6].name)
						// res.send(items)


						// var preIndexCheck =
						if (fromItem >= 0 && toItem >= 0 && fromItem < items.length && toItem < items.length) {
							// console.log("items are: ", items.length)
						
						// console.log("item test is name: ", items[1].name)
						var splicedItem = items.splice(fromItem, 1);
						// console.log("after removing item from array: ", items.length)
						// var splicedItem = vm.selectedProject.items[from]
						// console.log("spliced item is: ", splicedItem[0])
						
						items.splice(toItem, 0, splicedItem[0]);
						// console.log("newArray is: ", items);
							// array_move(items, selectedItem);

							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
						} else {
							res.send(
								`Selected from to index doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ELEMENT UP
	app.put("/project/:id/element/up", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var selectedElement = req.body.selectedElement;

		function array_move(arr, fromIndex) {
			var element = arr[fromIndex];
			arr.splice(fromIndex, 1);
			arr.splice(fromIndex - 1, 0, element);
		}

		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement)
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						// console.log("selectedItem is: ", selectedItem)
						// console.log("preIndexCheck is: ", preIndexCheck)
						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
						if (selectedItem <= preIndexCheck && selectedItem > 0) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
							// var elementIndexCheck = items[selectedItem].elements.length - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement > 0) {
								array_move(
									items[selectedItem].elements,
									selectedElement
								);
								for (
									var i = 0;
									i < items[selectedItem].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									items[selectedItem].elements[i].index = i;
									if (i === items[selectedItem].elements.length - 1) {
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numUpdated) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numUpdated > 0) {
														res.send(
															numUpdated.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
							// items.splice(selectedItem, 1);
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ELEMENT DOWN
	app.put("/project/:id/element/down", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var selectedElement = req.body.selectedElement;

		function array_move(arr, fromIndex) {
			var element = arr[fromIndex];
			arr.splice(fromIndex, 1);
			arr.splice(fromIndex + 1, 0, element);
		}

		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement)
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						// console.log("selectedItem is: ", selectedItem)
						// console.log("preIndexCheck is: ", preIndexCheck)
						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
						if (selectedItem <= preIndexCheck && selectedItem > 0) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
							var elementIndexCheck =
								items[selectedItem].elements.length - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {
								array_move(
									items[selectedItem].elements,
									selectedElement
								);
								for (
									var i = 0;
									i < items[selectedItem].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									items[selectedItem].elements[i].index = i;
									if (i === items[selectedItem].elements.length - 1) {
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numUpdated) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numUpdated > 0) {
														res.send(
															numUpdated.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
							// items.splice(selectedItem, 1);
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// MOVE ELEMENT
	app.put("/project/:id/element/move", async (req, res) => {
		console.log("REQ PARAMS: ", req.params);
		console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var fromItem = req.body.fromItem;
		var toItem = req.body.toItem;

		var fromElement = req.body.fromElement;
		var toElement = req.body.toElement;

		// function array_move(arr, fromIndex) {
		// 	var element = arr[fromIndex];
		// 	arr.splice(fromIndex, 1);
		// 	arr.splice(fromIndex + 1, 0, element);
		// }

		if (
			id &&
			id !== "undefined" &&
			!isNaN(fromItem) &&
			!isNaN(toItem) && 
			!isNaN(fromElement) && 
			!isNaN(toElement)
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						// console.log("selectedItem is: ", selectedItem)
						// console.log("preIndexCheck is: ", preIndexCheck)
						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
						if (fromItem >= 0 && toItem >= 0 && fromItem < items.length && toItem < items.length) {
						// if (selectedItem <= preIndexCheck && selectedItem > 0) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
							// var elementIndexCheck =
							// 	items[fromItem].elements.length - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							// if (fromElement <= elementIndexCheck) {
								var splicedElement = items[fromItem].elements.splice(fromElement, 1);
								// console.log("after removing item from array: ", items.length)
								// var splicedItem = vm.selectedProject.items[from]
								// console.log("spliced item is: ", splicedItem[0])
								
								items[toItem].elements.splice(toElement, 0, splicedElement[0]);
								// console.log("newArray is: ", items);
									// array_move(items, selectedItem);
		

									// RE-ORDER ONLY TO AND FROM ITEMS!?
for (var i = 0; i < items[fromItem].elements.length; ++i) {
	items[fromItem].elements[i].index = i;
}

if(fromItem !== toItem) {
	for (var i = 0; i < items[toItem].elements.length; ++i) {
		items[toItem].elements[i].index = i;
	}
}

// res.send(items)
		db.update(
												{ _id: id },
												{ $set: { items: items } },
												{},
												function (err, numUpdated) {
													if (err) {
														// console.log("err: ", err)
														res.send(err.toString());
													} else {
														if (numUpdated > 0) {
															res.send(
																numUpdated.toString()
															);
														} else {
															res.send("Didn't update");
														}
													}
												}
											);

									// for (var i = 0; i < items.length; ++i) {
									// 	// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									// 	items[i].index = i;
									// 	if (i === items.length - 1) {
									// 		db.update(
									// 			{ _id: id },
									// 			{ $set: { items: items } },
									// 			{},
									// 			function (err, numUpdated) {
									// 				if (err) {
									// 					// console.log("err: ", err)
									// 					res.send(err.toString());
									// 				} else {
									// 					if (numUpdated > 0) {
									// 						res.send(
									// 							numUpdated.toString()
									// 						);
									// 					} else {
									// 						res.send("Didn't update");
									// 					}
									// 				}
									// 			}
									// 		);
									// 	}
									// }



							
						
						} else {
							res.send(
								`Selected from to index doesn't Exist`
							);
						}
						
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// CUT ITEM
	app.put("/project/:id/item/cut", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;

	

		if (id && id !== "undefined" && !isNaN(selectedItem)) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						// var preIndexCheck =
						if (selectedItem > 0) {
							items.splice(selectedItem, 1);
							// array_move(items, selectedItem);

							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// PASTE ITEM
	app.put("/project/:id/item/paste", async (req, res) => {
		console.log("REQ PARAMS: ", req.params);
		console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var item = req.body.item;

	

		if (id && id !== "undefined" && !isNaN(selectedItem) && item) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						// var preIndexCheck =
						if (selectedItem > 0) {
							items.splice(selectedItem, 0, item);
							// array_move(items, selectedItem);

							for (var i = 0; i < items.length; ++i) {
								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
								items[i].index = i;
								if (i === items.length - 1) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numUpdated) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numUpdated > 0) {
													res.send(
														numUpdated.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// CUT ELEMENT
	app.put("/project/:id/element/cut", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var selectedElement = req.body.selectedElement;

		// function array_move(arr, fromIndex) {
		// 	var element = arr[fromIndex];
		// 	arr.splice(fromIndex, 1);
		// 	arr.splice(fromIndex + 1, 0, element);
		// }

		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement)
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						// console.log("selectedItem is: ", selectedItem)
						// console.log("preIndexCheck is: ", preIndexCheck)
						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
						if (selectedItem <= preIndexCheck && selectedItem >= 0) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
							var elementIndexCheck =
								items[selectedItem].elements.length - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {

								// console.log("removed element arraybefore  is: ", items[selectedItem].elements.length)
								items[selectedItem].elements.splice(selectedElement, 1);
								// console.log("removed element array after  is: ", items[selectedItem].elements.length)
								// console.log("newitems length is: ", newItems.length)

								for (
									var i = 0;
									i < items[selectedItem].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									items[selectedItem].elements[i].index = i;
									// console.log("index is: ", i, "and items length is: ", items[selectedItem].elements.length)
									// console.log("items length is : ", items.length)
									if (i === items[selectedItem].elements.length - 1) {
										// console.log("at last of update!")
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numUpdated) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numUpdated > 0) {
														res.send(
															numUpdated.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
							} else {
								res.send(
									`Selected Index of element ${selectedElement} doesn't Exist`
								);
							}
							// items.splice(selectedItem, 1);
						} else {
							res.send(
								`Selected Index of item ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// PASTE ELEMENT
	app.put("/project/:id/element/paste", async (req, res) => {
		console.log("REQ PARAMS: ", req.params);
		console.log("REQ BODY: ", req.body);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var selectedElement = req.body.selectedElement;
		var element = req.body.element;

		// function array_move(arr, fromIndex) {
		// 	var element = arr[fromIndex];
		// 	arr.splice(fromIndex, 1);
		// 	arr.splice(fromIndex + 1, 0, element);
		// }

		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement) && element
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						const items = doc.items;
						var preIndexCheck = items.length - 1;
						// console.log("selectedItem is: ", selectedItem)
						// console.log("preIndexCheck is: ", preIndexCheck)
						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
						if (selectedItem <= preIndexCheck && selectedItem >= 0) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
							var elementIndexCheck =
								items[selectedItem].elements.length - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {

								// console.log("removed element arraybefore  is: ", items[selectedItem].elements.length)
								items[selectedItem].elements.splice(selectedElement, 0, element);
								// console.log("removed element array after  is: ", items[selectedItem].elements.length)
								// console.log("newitems length is: ", newItems.length)

								for (
									var i = 0;
									i < items[selectedItem].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									items[selectedItem].elements[i].index = i;
									// console.log("index is: ", i, "and items length is: ", items[selectedItem].elements.length)
									// console.log("items length is : ", items.length)
									if (i === items[selectedItem].elements.length - 1) {
										// console.log("at last of update!")
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numUpdated) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numUpdated > 0) {
														res.send(
															numUpdated.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
							} else {
								res.send(
									`Selected Index of element ${selectedElement} doesn't Exist`
								);
							}
							// items.splice(selectedItem, 1);
						} else {
							res.send(
								`Selected Index of item ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});
	// CREATE NEW ELEMENT
	app.post("/project/:id/element", async (req, res) => {
		// check if index exists - needed for reading!
		console.log("REQ BODY: ", req.body);
		console.log("REQ PARAMS: ", req.params);

		// CHECK IF NULL OR UNDEFINED

		var id = req.params.id;
		// var newItem = req.body;
		var selectedItem = req.body.selectedItem;
		if (selectedItem === null) {
			selectedItem = 0;
		}
		var selectedElement = req.body.selectedElement;
		if (selectedElement === null) {
			selectedElement = 0;
		}
		var template = req.body.template;

		// CHECK THAT TEMPLATE ISN't NULL
		if (
			template &&
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement)
		) {
			// CHECK IF PROJECT EXISTS
			// var projectPath = path.join(
			// 	process.env.NODECG_ROOT,
			// 	"/db/projects/" + projectName + ".db"
			// );
			// if (fs.existsSync(projectPath)) {
			// 	var db = new Datastore({
			// 		filename: projectPath,
			// 		autoload: true,
			// 	});

			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					// console.log("doc is: ", doc)
					if (doc) {
						// console.log("doc is defined")
						const items = doc.items;

						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							var preElementIndexCheck =
								items[selectedItem].elements.length === 0
									? 1
									: items[selectedItem].elements.length;
							var elementIndexCheck = preElementIndexCheck - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {
								// console.log("passed element check")
								// console.log("newDocs are: ", newDocs[0].elements)
								// res.send(newDocs);
								// 	// OBJECT CREATION
								// 	const indexedElement = {
								// 		index: 0,
								// 		name: newItem.name,
								// 		type: newItem.type,
								// 		// FROM HERE DIFFERS
								// 		position: newItem.person,
								// 		title: newItem.title,
								// 	};
								//    // OBJECT CREATION - END

								// CHECK IF ANY ITEMS
								if (
									selectedItem >= 0
								) {
									// console.log("itemIndex isn't null or undefined",);

									// CHECK IF ITEM EXISTS
									// if (typeof items[selectedItem] !== "undefined") {
									// ITEM EXISTS
									// if (
									// 	selectedElement !== null ||
									// 	selectedElement !== undefined
									// ) {
									// CHECK IF ELEMENT EXISTS ELSE USE 0

									if (
										typeof items[selectedItem].elements[
											selectedElement
										] !== "undefined"
									) {
										// ELEMENT EXISTS
										var selectedItemIndex = selectedItem;
										var selectedElementIndex =
											selectedElement;
									} else {
										// ELEMENT DOESN"T EXIST - PUSH TO 0
										var selectedItemIndex = selectedItem;
										var selectedElementIndex = 0;
									}
									// } else {
									// 	// ELEMENT DOESN"T EXIST - PUSH TO 0
									// 	var selectedItemIndex = selectedItem;
									// 	var selectedElementIndex = 0;
									// }
								} else {
									// ITEM DOESN"T EXIST
									var selectedItemIndex = 0;
									var selectedElementIndex = 0;
									// res.send(false)
								}
								// } else {
								// 	// NO INDEXES PROVIDED
								// 	var selectedItemIndex = 0;
								// 	var selectedElementIndex = 0;
								// }

								// console.log("selectedItemIndex is: ", selectedItemIndex)
								// console.log("selectedElementIndex is: ", selectedElementIndex)
								items[selectedItemIndex].elements.splice(
									selectedElementIndex,
									0,
									template
								);
								for (
									var i = 0;
									i <
									items[selectedItemIndex].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
									items[selectedItemIndex].elements[i].index =
										i;
									if (
										i ===
										items[selectedItemIndex].elements
											.length -
											1
									) {
										// console.log("at final loop")
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numUpdated) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numUpdated > 0) {
														res.send(
															numUpdated.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
								// if (items[selectedElement].elements.length === 0) {
								// 	db.update(
								// 		{ _id: id },
								// 		{ $set: { items: items } },
								// 		{},
								// 		function (numUpdated) {
								// 			// db.findOne({ _id: id }, function (err, updatedDoc) {
								// 			res.send(numUpdated);
								// 			// });
								// 		}
								// 	);
								// }
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}

						// newDocs.elements.unshift(req.body.superTemplate);
						// const newElements = items[selectedItemIndex].elements;

						// db.update(
						// 	{ _id: id },
						// 	{ $set: { items: items } },
						// 	{},
						// 	function () {
						// 		res.send(doc);
						// 	}
						// );
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
			// } else {
			// 	// FILE DOESN't EXIST!
			// 	res.send(false);
			// }
		} else {
			res.send("Basic Parameters are undefined!");
		}
	});

	// UPDATE ELEMENT NAME
	app.put("/project/:id/elementname", async (req, res) => {
		// 	console.log("REQ BODY: ", req.body);
		//   console.log("REQ PARAMS: ", req.params);
		var id = req.params.id;
		var selectedElement = req.body.selectedElement;
		var selectedItem = req.body.selectedItem;
		var newName = req.body.name;
		// console.log("id is: ", id)
		// console.log("index is: ", index)
		// console.log("newName is: ", newName)
		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedElement) &&
			!isNaN(selectedItem) &&
			newName &&
			newName !== "undefined"
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					// console.log("doc is: ", doc)
					if (doc) {
						// console.log("doc is defined")
						const items = doc.items;
						var indexCheck = items.length - 1;
						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							var preElementIndexCheck =
								items[selectedItem].elements.length === 0
									? 1
									: items[selectedItem].elements.length;
							var elementIndexCheck = preElementIndexCheck - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {
								items[selectedItem].elements[
									selectedElement
								].name = newName;
								db.update(
									{ _id: id },
									{ $set: { items: items } },
									{},
									function (err, numUpdated) {
										if (err) {
											// console.log("err: ", err)
											res.send(err.toString());
										} else {
											if (numUpdated > 0) {
												res.send(numUpdated.toString());
											} else {
												res.send("Didn't update");
											}
										}
									}
								);
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}

		// // console.log("req.body is: ", req.body)
		// var id = req.body._id;
		// var newName = req.body.name;
		// var index = req.body.index;

		// db.findOne({ _id: id }, function (err, doc) {
		// 	const newDocs = doc;
		// 	newDocs.elements[index].name = newName;
		// 	const newArray = newDocs.elements;

		// 	db.update(
		// 		{ _id: id },
		// 		{ $set: { elements: newArray } },
		// 		{},
		// 		function () {
		// 			res.send(doc);
		// 		}
		// 	);
		// });

		// }
		// });
	});

	// UPDATE ELEMENT Totally
	app.put("/project/:id/element", async (req, res) => {
		// 	console.log("REQ BODY: ", req.body);
		//   console.log("REQ PARAMS: ", req.params);
		var id = req.params.id;
		var selectedElement = req.body.selectedElement;
		var selectedItem = req.body.selectedItem;
		var newName = req.body.name;
		// console.log("id is: ", id)
		// console.log("index is: ", index)
		// console.log("newName is: ", newName)
		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedElement) &&
			!isNaN(selectedItem) &&
			newName &&
			newName !== "undefined"
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					// console.log("doc is: ", doc)
					if (doc) {
						// console.log("doc is defined")
						const items = doc.items;
						var indexCheck = items.length - 1;
						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							var preElementIndexCheck =
								items[selectedItem].elements.length === 0
									? 1
									: items[selectedItem].elements.length;
							var elementIndexCheck = preElementIndexCheck - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {
								items[selectedItem].elements[
									selectedElement
								].name = newName;
								db.update(
									{ _id: id },
									{ $set: { items: items } },
									{},
									function (err, numUpdated) {
										if (err) {
											// console.log("err: ", err)
											res.send(err.toString());
										} else {
											if (numUpdated > 0) {
												res.send(numUpdated.toString());
											} else {
												res.send("Didn't update");
											}
										}
									}
								);
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
						}
						// console.log("before docs name is: ", items[index].name)
					} else {
						res.send(`Project ${id} doesn't Exist`);
					}
				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}

		// // console.log("req.body is: ", req.body)
		// var id = req.body._id;
		// var newName = req.body.name;
		// var index = req.body.index;

		// db.findOne({ _id: id }, function (err, doc) {
		// 	const newDocs = doc;
		// 	newDocs.elements[index].name = newName;
		// 	const newArray = newDocs.elements;

		// 	db.update(
		// 		{ _id: id },
		// 		{ $set: { elements: newArray } },
		// 		{},
		// 		function () {
		// 			res.send(doc);
		// 		}
		// 	);
		// });

		// }
		// });
	});
	// DELETE SPECIFIC ELEMENT
	app.post("/project/:id/deleteelement", async (req, res) => {
		// 	console.log("REQ BODY: ", req.body);
		//   console.log("REQ PARAMS: ", req.params);

		var id = req.params.id;
		var selectedItem = req.body.selectedItem;
		var selectedElement = req.body.selectedElement;

		// console.log("id is: ", id)
		// console.log("index is: ", index)
		// console.log("newName is: ", newName)
		if (
			id &&
			id !== "undefined" &&
			!isNaN(selectedItem) &&
			!isNaN(selectedElement)
		) {
			// console.log("passed tests")
			db.findOne({ _id: id }, function (err, doc) {
				if (err) {
					res.send(err.toString());
				} else {
					if (doc) {
						// console.log("")
						const items = doc.items;
						var preIndexCheck =
							items.length === 0 ? 1 : items.length;
						var indexCheck = preIndexCheck - 1;
						if (selectedItem <= indexCheck) {
							// CHECK THAT INDEX ISN' ABOVE LENGTH
							var preElementIndexCheck =
								items[selectedItem].elements.length === 0
									? 1
									: items[selectedItem].elements.length;
							var elementIndexCheck = preElementIndexCheck - 1;
							// var trueLength = items[selectedItem].elements.length - 1
							// console.log("elements are: ", elementsIndexCheck)
							if (selectedElement <= elementIndexCheck) {
								// items[itemIndex].elements[index].name = newName

								items[selectedItem].elements.splice(
									selectedElement,
									1
								);
								// console.log("length is: ", items[itemIndex].elements.length)

								for (
									var i = 0;
									i < items[selectedItem].elements.length;
									++i
								) {
									// console.log("i'm at number:", i, " and object's index is: ", items[itemIndex].elements[index].index)
									items[selectedItem].elements[i].index = i;
									if (
										i ===
										items[selectedItem].elements.length - 1
									) {
										// console.log("i am at last loop")
										db.update(
											{ _id: id },
											{ $set: { items: items } },
											{},
											function (err, numRemoved) {
												if (err) {
													// console.log("err: ", err)
													res.send(err.toString());
												} else {
													if (numRemoved > 0) {
														res.send(
															numRemoved.toString()
														);
													} else {
														res.send(
															"Didn't update"
														);
													}
												}
											}
										);
									}
								}
								if (items[selectedItem].elements.length === 0) {
									db.update(
										{ _id: id },
										{ $set: { items: items } },
										{},
										function (err, numRemoved) {
											if (err) {
												// console.log("err: ", err)
												res.send(err.toString());
											} else {
												if (numRemoved > 0) {
													res.send(
														numRemoved.toString()
													);
												} else {
													res.send("Didn't update");
												}
											}
										}
									);
								}
							} else {
								res.send(
									`Selected Index of ${selectedElement} doesn't Exist`
								);
							}
						} else {
							res.send(
								`Selected Index of ${selectedItem} doesn't Exist`
							);
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

	log.trace(`Attempting to listen on ${config.host}:${config.port}`);
	server.on("error", (err) => {
		switch (err.code) {
			case "EADDRINUSE":
				if (process.env.NODECG_TEST) {
					return;
				}

				log.error(
					`[server.js] Listen ${config.host}:${config.port} in use, is NodeCG already running? NodeCG will now exit.`
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
			port: process.env.NODECG_TEST ? undefined : config.port,
		},
		() => {
			if (process.env.NODECG_TEST) {
				const { port } = server.address();
				log.warn(
					`Test mode active, using automatic listen port: ${port}`
				);
				configHelper.config.port = port;
				configHelper.filteredConfig.port = port;
				process.env.NODECG_TEST_PORT = port;
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
