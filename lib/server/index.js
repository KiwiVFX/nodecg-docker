"use strict";

const pjson = require("../../package.json");
const configHelper = require("../config");
// const short = require('short-uuid');
const ShortUniqueId = require("short-unique-id");
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
const { indexOf } = require("lodash");

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
	const mongoose = require("mongoose");
	const { Project, Item, Element/*, Super, Stripe, Box, CG, Finger, Counter, Live, Ticker, Roller, Promo*/ } = require("./schema/model");
	const cors = require("cors");
	app.use(cors());
	var routesPrefix = "/projects"

	const options = {
		autoIndex: false, // Don't build indexes
		reconnectTries: 30, // Retry up to 30 times
		reconnectInterval: 500, // Reconnect every 500ms
		poolSize: 10, // Maintain up to 10 socket connections
		// If not connected, return errors immediately rather than waiting for reconnect
		bufferMaxEntries: 0
	  }
	
	const connectWithRetry = () => {
	  console.log('MongoDB connection with retry')
	  mongoose.connect("mongodb://nodecg-test-1.herokuapp.com/livecg", options).then(()=>{
		console.log('MongoDB is connected')
	  }).catch(err=>{
		console.log('MongoDB connection unsuccessful, retry after 5 seconds.')
		setTimeout(connectWithRetry, 5000)
	  })
	}
	
	connectWithRetry()
	
	// CREATE PROJECT
	app.post(routesPrefix + "/:name", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var overwrite = false;
		var name = req.params.name;
		var project = {name: name, items: []}
		if (req.body.overwrite) {
			overwrite = true;
			if (req.params.items && req.params.items.length > 0) {
				project.items = req.params.items;
			} else {
				var items = [];
				var item = {
					// index: 0,
					name: "Ex. First Item",
					expanded: true,
					options: false,
					elements: [],
					uid: uid(),
				};
				items.push(item);
			}
			
		}
		if (name && name !== "undefined" && name !== "null" && isNaN(name)) {
			Project.find({}, "name").exec((err, projects) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					// CHECK DOCS LENGTH - MAX. 50
					if (projects.length >= 50) {
						res.send(
							`Maximum is 50 projects, please remove some to add new!`
						);
					} else {
						if (projects) {
							for (var i = 0; i < projects.length; ++i) {
								// LOOP THROUGH RESULTS AND CHECK IF NAME EXISTS
								if (projects[i].name.toLowerCase() === name.toLowerCase() && !overwrite ) {
									res.send(`Name exists!`);
									break;
								} else {
									if (i === projects.length - 1) {
										if(overwrite) {
											Project.deleteOne({ _id: projects[i]._id }, function (err, project) {
												if (err) {
													res.send(err.toString());
													throw err;
												} else {
														// if no project - returns null
													const new_project = new Project(project);
													new_project.save(function ( err, project) {
														// if no project - returns null
														if (err) {
															res.send(err.toString());
															throw err;
														} else {

															
															const itemTemplate = {
																// index: null,
																name: "New Example Item",
																expanded: true,
																options: false,
																elements: [],
															};
															const new_item = new Item(itemTemplate);
															
															Project.updateOne(
															  { _id: project._id },
															  { $push: { items: {$each: [new_item], $position: 0 } } },
															  { new: true },
															  function (err, status) {
																if (err) {
																	res.send(err.toString());
																	throw err;
																} else res.send(status);
																
															  }
															);
														}
													});
												}
												
											});
										} else {
											const new_project = new Project(
												project
											);
											new_project.save(function ( err, project) {
												// if no project - returns null
												if (err) {
													res.send(err.toString());
													throw err;
												} else {
													
													const itemTemplate = {
														// index: null,
														name: "New Example Item",
														expanded: true,
														options: false,
														elements: [],
													};
													const new_item = new Item(itemTemplate);
													
													Project.updateOne(
													  { _id: project._id },
													  { $push: { items: {$each: [new_item], $position: 0 } } },
													  { new: true },
													  function (err, status) {
														if (err) {
															res.send(err.toString());
															throw err;
														} else res.send(status);
														
													  }
													);
												}
											});
										}
										
									}
								}
							}
							if (projects.length === 0) {
									const new_project = new Project(
										project
									);
									new_project.save(function ( err, project) {
										// if no project - returns null
										if (err) {
											res.send(err.toString());
											throw err;
										} else {
											const itemTemplate = {
												// index: null,
												name: "New Example Item",
												expanded: true,
												options: false,
												elements: [],
											};
											const new_item = new Item(itemTemplate);
											
											Project.updateOne(
											  { _id: project._id },
											  { $push: { items: {$each: [new_item], $position: 0 } } },
											  { new: true },
											  function (err, status) {
												if (err) {
													res.send(err.toString());
													throw err;
												} else res.send(status);
												
											  }
											);
										}
									});
									
								// }
							}
						} else res.send("No projects found!");
					}
				}
			});
		} else res.send("Name is invalid.");
	});

	// VALIDATE PROJECT EXISTANCE
	app.get(routesPrefix + "/:name/prompt", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		const name = req.params.name;
		if (name && name !== "undefined" && name !== "null" && isNaN(name)) {
			Project.findOne({ name: req.params.name }, "name").exec(
				(err, project) => {
					if (err) {
						res.send(err.toString());
						throw err;
					} else res.json(project);
				}
			);
		} else res.send("Missing credentials.");
	});

	// GET PROJECT
	app.get(routesPrefix + "/:id", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		const id = req.params.id;
		if (mongoose.isValidObjectId(id)) {
			Project
			.findOne({ _id: id })
			    .populate({ 
					path: "items",      // 1st level subdoc (get comments)
					populate: {         // 2nd level subdoc (get users in comments)
					  path: "elements", // select: 'avatar name _id'// space separated (selected fields only)
					}
				  })
				.exec((err, project) => {
					if (err) {
						res.send(err.toString());
						throw err;
					} else res.json(project);
				});
		} else res.send("Basic Parameters are undefined!");
	});

	// GET ALL PROJECTS
	app.get(routesPrefix, async (req, res) => {
		Project
		.find({}, "name items")
		// .populate("items")
		.exec((err, project) => {
			if (err) {
				res.send(err.toString());
				throw err;
			} else res.json(project);
		});
	});

	// RENAME PROJECT BY ID
	app.post(routesPrefix + "/:id/rename", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var id = req.params.id;
		var newName = req.body.newName;
		if (mongoose.isValidObjectId(id) && newName && newName !== "undefined" && newName !== "null" && isNaN(newName)) {
			Project.updateOne(
				{ _id: id },
				{ $set: { name: newName } },
				function (err, status) {
					if (err) {
						res.send(err.toString());
						throw err;
					} else res.json(status);
				}
			);
		} else res.send("Basic Parameters are undefined!");
	});

	// DELETE SPECIFIC PROJECT
	app.delete("/:id", async (req, res) => {
		// console.log("REQ PARAMS: ", req.params);
		// console.log("REQ BODY: ", req.body);
		var id = req.params.id;
		if (mongoose.isValidObjectId(id)) {
			Project.deleteOne({ _id: id }, function (err, status) {
				if (err) {
					res.send(err.toString());
					throw err;
				} else res.json(status);
			});
		} else res.send("Basic Parameters are undefined!");
	});

	// CREATE NEW ITEM
	app.post(routesPrefix + "/:id/item", async (req, res) => {
		var id = req.params.id;
		var position = req.body.index;
		var itemName = req.body.name
		var template = req.body.template
		const itemTemplate = {
			// index: null,
			name: "New Example Item",
			expanded: true,
			options: false,
			elements: [],
		};
	if(itemName && itemName !== "undefined" && itemName !== "null" && isNaN(itemName)) {
				itemTemplate.name = itemName
				};
		// MAKE SURE YOU DON'T FORGET ELEMENTS COPIED ON CREATION!!!
		// if (position === null || position === undefined) {
		// 	position = 0;
		// }
		// RE-WRITE WITHOUT THIS CASE
		var templateCheck = template
		if(!isNaN(position) && templateCheck && mongoose.isValidObjectId(id)) {
			if(template && template.elements && template.elements.length > 0) {
				var createElements = template.elements
				template.elements = []
			} else var template = itemTemplate

			if(!position) {
				position = 0
			}
// res.send("ok")
		// if(itemName && itemName !== "undefined" && itemName !== "null" && isNaN(itemName)) {
		// 		itemTemplate.name = itemName
		// 		};
		
			// if (mongoose.isValidObjectId(id)) {
				// template.name = itemName
									  const new_item = new Item(template);
									  new_item.save();
	// if(isNaN(position))
									  Project.findOneAndUpdate(
									 { _id: id },
		{ $push: { items: {$each: [new_item], $position: position } } },
		{ safe: true, upsert: true, returnOriginal: false },
		function (err, project) {
			if(project) {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					// res.send(status);
					
					if(createElements.length > 0) {
						var newElements = []
						var itemId = project.items[position]
						// console.log("item id is: ", itemId)
						// console.log("Elements length is: :", createElements.length)
						for (var i = 0; i < createElements.length; ++i) {
							// console.log("current index is: ", i)
							var currentIndex = (i + 1)
							
							// console.log("currentIndex is: ", currentIndex, " Of length is: ", createElements.length)
							// console.log("do match is: ", currentIndex === createElements.length)
							delete createElements[i]._id
							const new_element = new Element(createElements[i]);
							new_element.save();
							newElements.push(new_element)
							if(currentIndex === createElements.length) {
								// console.log("newDoc id is: ", newDoc._id)
							Item.updateOne(
							{ _id: itemId },
							{ $push: { elements: {$each: newElements, $position: i } } },
							{ safe: true, upsert: true },
							function (err, test) {
								// console.log("added Element status: ", status)
							if (err) {
							res.send(err.toString());
							throw err;
							} else {
								// console.log("added element")
								// console.log("index is: ", i)
								
								//  else res.send("Something went wrong.")
								// if(currentIndex === createElements.length) {
									// console.log("last index")
									// res.send("overall status is: ", test)
									res.send(test);
								// } else {
								// 	console.log("looping more")
								// }
								
							}
							}
							);
						}
							
														}	
					} else res.send(project)
					
				}
			} else res.send("Something went wrong with project")
			// console.log("project is: ", project)
			
		}
	  );
			// }
						
		} else {
			res.send("Basic Parameters are undefined!");
	
		}
		


















			// 		if(itemName && itemName !== "undefined" && itemName !== "null" && isNaN(itemName)) {
	// 			itemTemplate.name = itemName
	// 			};
		
	// 		if (mongoose.isValidObjectId(id)) {
	// 								  const new_item = new Item(itemTemplate);
	// 								  new_item.save();
	// // if(isNaN(position))
	// 								  Project.updateOne(
	// 								 { _id: id },
	// 	{ $push: { items: {$each: [new_item], $position: 0 } } },
	// 	{ safe: true, upsert: true },
	// 	function (err, status) {
	// 		if (err) {
	// 			res.send(err.toString());
	// 			throw err;
	// 		} else res.send(status);
	// 	}
	//   );
	// 		}
	});

// GET ITEM BY ID
app.get(routesPrefix + "/:itemid", async (req, res) => {
	// console.log("REQ PARAMS: ", req.params);
	// console.log("REQ BODY: ", req.body);
	var itemid = req.params.itemid;
	if (mongoose.isValidObjectId(itemid)) {
		Item.findOne({ _id: itemid })
		.populate("elements")
		.exec((err, item) => {
			if (err) {
				res.send(err.toString());
				throw err;
			} else res.send(item);
			});
	} else res.send("Basic Parameters are undefined!");
});

		// UPDATE ITEM NAME
		app.put(routesPrefix + "/:itemid", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);
			var itemid = req.params.itemid;
			var newName = req.body.name;
			var addAbove = false
			if (mongoose.isValidObjectId(itemid) /*&& !isNaN(selectedItem) */&& newName && newName !== "undefined" && newName !== "null" && isNaN(newName)) {
				Item.updateOne(
					{ _id: itemid },
					{ $set: { name: newName } },
					function (err, status) {
						if (err) {
							res.send(err.toString());
							throw err;
						} else res.send(status);
					}
				);
			} else res.send("Basic Parameters are undefined!");
		});

		// DELETE SPECIFIC ITEM
		app.delete(routesPrefix + "/:itemid", async (req, res) => {
			// 	console.log("REQ BODY: ", req.body);
			//   console.log("REQ PARAMS: ", req.params);
			
			var itemid = req.params.itemid;
			var removeIds = []
			
	Item.findOne({ _id: itemid })
	.populate("elements")
		.exec((err, item) => {
			if (err) {
				res.send(err.toString());
				throw err;
			} else {
				// Project.updateOne({ 
				// 	"items" : { $in : [itemid] } 
				// }, { 
				// 	$pullAll : { "items" : [itemid] }
				// } , (err, status) => {
			// res.send(item)
			// console.log("item is: ", item)
			// console.log("elements are: ", item.elements)
			// console.log("length is: ", item.elements.length)
			if(item && item.elements && item.elements.length > 0 ) {
				var removeElements = []
				for (var i = 0; i < item.elements.length; ++i) {
// console.log("remove id: ", item.elements[i]._id)
removeElements.push(item.elements[i]._id)
				}
				// console.log("remove following: ", removeElements)
				Element.deleteMany({ _id: removeElements }, function (err, element) {
					if (err) {
						res.send(err.toString());
						throw err;
					} else {
						// console.log("done")
									Item.deleteOne({ _id: itemid }, function (err, item) {
				if (err) {
					res.send(err.toString());
					throw err;
				} else res.send(item)
				
			});
					}
				});
			} else res.send(item)
		
				// })
			}
			});
		
		
		
		// , function (err, item) {
					
					
				// });
			// if (mongoose.isValidObjectId(itemid)) {
			// 	Item.deleteOne({ _id: itemid }, function (err, item) {
			// 		if (err) {
			// 			res.send(err.toString());
			// 			throw err;
			// 		} else {
			// 			Project.updateOne({ 
			// 				"items" : { $in : [itemid] } 
			// 			}, { 
			// 				$pullAll : { "items" : [itemid] }
			// 			} , (err, status) => {
			// 		res.send(status)
			// 			})
			// 		}
					
			// 	});
			// } else {
			// 	res.send("Basic Parameters are undefined!");
			// }
		});

			// CREATE NEW ELEMENT
		app.post(routesPrefix + "/:id/element", async (req, res) => {
			// check if index exists - needed for reading!
			console.log("REQ BODY: ", req.body);
			console.log("REQ PARAMS: ", req.params);
			var id = req.params.id;
			// var selectedItem = req.body.selectedItem;
			// // CHECK IF NULL OR UNDEFINED
			// if (selectedItem === null) {
			// 	selectedItem = 0;
			// }
			// var selectedElement = req.body.selectedElement;
			// if (selectedElement === null) {
			// 	selectedElement = 0;
			// }
			var position = req.body.index
			var template = req.body.template;

			// CHECK THAT TEMPLATE ISN't NULL
			var templateCheck = template && template.type
			if (templateCheck && mongoose.isValidObjectId(id) && !isNaN(position)) {
				console.log("position is: ", position)
// if(!isNaN(position)) {
	// console.log("doing position")
	// res.send("Doing pos")
// } else {
	Item.findOne({ _id: id})
	.exec((err, item) => {
		if (err) {
			res.send(err.toString());
			throw err;
		} else {
					// CHECK THAT INDEX ISN' ABOVE LENGTH
					// var elementIndexCheck = item.elements.length - 1;
					// console.log("elements length is: ", item.elements.length)
				
					if(!position) {
						position = 0
					}

						if (position <= item.elements.length && position >= 0) {
							const new_element = new Element(template);
							new_element.save();
	
							Item.updateOne(
						   { _id: id },
	{ $push: { elements: {$each: [new_element], $position: position } } },
	{ safe: true, upsert: true },
	function (err, status) {
	
	if (err) {
	res.send(err.toString());
	throw err;
	} else res.send(status);
	}
	);
					} else res.send(`Selected Index of ${position} doesn't Exist`);
						
		}
	});
// }
				
						
			} else res.send("Basic Parameters are undefined!");
		});

		// UPDATE ELEMENT NAME
		app.put(routesPrefix + "/item/:id", async (req, res) => {
			// 	console.log("REQ BODY: ", req.body);
			//   console.log("REQ PARAMS: ", req.params);
			var id = req.params.id;
			var newName = req.body.name;
			if (
				mongoose.isValidObjectId(id) &&
				newName && newName !== "undefined" && newName !== "null" && isNaN(newName)
			) {
								Element.updateOne(
									{ _id: id },
									{ $set: { name: newName } },
									function (err, status) {
										if (err) {
											res.send(err.toString());
											throw err;
										} else res.send(status);
									}
								);
			} else res.send("Basic Parameters are undefined!");
		});

	// 	// UPDATE ELEMENT Totally
	// 	app.put("/item/:id", async (req, res) => {
	// 		// 	console.log("REQ BODY: ", req.body);
	// 		//   console.log("REQ PARAMS: ", req.params);
	// 		var id = req.params.id;
	// 		var selectedElement = req.body.selectedElement;
	// 		var selectedItem = req.body.selectedItem;
	// 		var newName = req.body.name;
	// 		// console.log("id is: ", id)
	// 		// console.log("index is: ", index)
	// 		// console.log("newName is: ", newName)
	// 		if (
	// 			id &&
	// 			id !== "undefined" &&
	// 			!isNaN(selectedElement) &&
	// 			!isNaN(selectedItem) &&
	// 			newName &&
	// 			newName !== "undefined"
	// 		) {
	// 			// console.log("passed tests")
	// 			db.findOne({ _id: id }, function (err, doc) {
	// 				if (err) {
	// 					res.send(err.toString());
	// 				} else {
	// 					// console.log("doc is: ", doc)
	// 					if (doc) {
	// 						// console.log("doc is defined")
	// 						const items = doc.items;
	// 						var indexCheck = items.length - 1;
	// 						var preIndexCheck =
	// 							items.length === 0 ? 1 : items.length;
	// 						var indexCheck = preIndexCheck - 1;
	// 						if (selectedItem <= indexCheck) {
	// 							// CHECK THAT INDEX ISN' ABOVE LENGTH
	// 							var preElementIndexCheck =
	// 								items[selectedItem].elements.length === 0
	// 									? 1
	// 									: items[selectedItem].elements.length;
	// 							var elementIndexCheck = preElementIndexCheck - 1;
	// 							// var trueLength = items[selectedItem].elements.length - 1
	// 							// console.log("elements are: ", elementsIndexCheck)
	// 							if (selectedElement <= elementIndexCheck) {
	// 								items[selectedItem].elements[
	// 									selectedElement
	// 								].name = newName;
	// 								db.update(
	// 									{ _id: id },
	// 									{ $set: { items: items } },
	// 									{},
	// 									function (err, numUpdated) {
	// 										if (err) {
	// 											// console.log("err: ", err)
	// 											res.send(err.toString());
	// 										} else {
	// 											if (numUpdated > 0) {
	// 												res.send(numUpdated.toString());
	// 											} else {
	// 												res.send("Didn't update");
	// 											}
	// 										}
	// 									}
	// 								);
	// 							} else {
	// 								res.send(
	// 									`Selected Index of ${selectedElement} doesn't Exist`
	// 								);
	// 							}
	// 						} else {
	// 							res.send(
	// 								`Selected Index of ${selectedItem} doesn't Exist`
	// 							);
	// 						}
	// 						// console.log("before docs name is: ", items[index].name)
	// 					} else {
	// 						res.send(`Project ${id} doesn't Exist`);
	// 					}
	// 				}
	// 			});
	// 		} else {
	// 			res.send("Basic Parameters are undefined!");
	// 		}

	// 		// // console.log("req.body is: ", req.body)
	// 		// var id = req.body._id;
	// 		// var newName = req.body.name;
	// 		// var index = req.body.index;

	// 		// db.findOne({ _id: id }, function (err, doc) {
	// 		// 	const newDocs = doc;
	// 		// 	newDocs.elements[index].name = newName;
	// 		// 	const newArray = newDocs.elements;

	// 		// 	db.update(
	// 		// 		{ _id: id },
	// 		// 		{ $set: { elements: newArray } },
	// 		// 		{},
	// 		// 		function () {
	// 		// 			res.send(doc);
	// 		// 		}
	// 		// 	);
	// 		// });

	// 		// }
	// 		// });
	// 	});
		// DELETE SPECIFIC ELEMENT
		app.delete(routesPrefix + "/item/:id", async (req, res) => {
			// 	console.log("REQ BODY: ", req.body);
			//   console.log("REQ PARAMS: ", req.params);

			var id = req.params.id;
			if (
				mongoose.isValidObjectId(id)
			) {
				Element.deleteOne({ _id: id }, function (err, element) {
					if (err) {
						res.send(err.toString());
						throw err;
					} else {
						Item.updateOne({ 
							"elements" : { $in : [id] } 
						}, { 
							$pullAll : { "elements" : [id] }
						} , (err, status) => {
					res.send(status)
						})
					}
				});
			} else {
				res.send("Basic Parameters are undefined!");
			}
		});

		// MOVE ITEM UP
		app.put(routesPrefix + "/:id/item/up", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);

			var id = req.params.id
			var index = req.body.index;
			if (mongoose.isValidObjectId(id)) {
			Project.findOne({ _id: id }, "items")
			.populate({ 
				path: "items"
			  })
			.exec((err, project) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(project) {
						
						if(index > 0 && project.items.length > 1 && (project.items.length - 1) >= index) {
							var savedItem = project.items[index]
							var itemid = project.items[index]._id
							if(savedItem instanceof Item && mongoose.isValidObjectId(itemid)) {
								Project.updateOne({ 
									"items" : { $in : [itemid] } 
								}, { 
									$pullAll : { "items" : [itemid] }
								} , (err, pullStatus) => {
									if(pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
										var newIndex = index - 1
									Project.updateOne(
										{ _id: id },
		   { $push: { items: {$each: [savedItem], $position: newIndex } } },
		   { safe: true, upsert: true },
		   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push item. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling item.")
								})
							} else res.send("Problem with saved item or id.")
							
							
						} else res.send("Problem with index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		});

		// MOVE ITEM DOWN
		app.put(routesPrefix + "/:id/item/down", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);

			var id = req.params.id
			var index = req.body.index;
			if (mongoose.isValidObjectId(id)) {
			Project.findOne({ _id: id }, "items")
			.populate({ 
				path: "items"
			  })
			.exec((err, project) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(project) {
						
						if(index >= 0 && project.items.length >= 1 && index < (project.items.length - 1)) {
							var savedItem = project.items[index]
							var itemid = project.items[index]._id
							if(savedItem instanceof Item && mongoose.isValidObjectId(itemid)) {
								Project.updateOne({ 
									"items" : { $in : [itemid] } 
								}, { 
									$pullAll : { "items" : [itemid] }
								} , (err, pullStatus) => {
									if(pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
										var newIndex = index + 1
									Project.updateOne(
										{ _id: id },
		   { $push: { items: {$each: [savedItem], $position: newIndex } } },
		   { safe: true, upsert: true },
		   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push item. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling item.")
								})
							} else res.send("Problem with saved item or id.")
							
							
						} else res.send("Problem with index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		});

		// MOVE ITEM
		app.put(routesPrefix + "/:id/item/move", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);
			var id = req.params.id
			var fromItem = req.body.fromItem;
			var toItem = req.body.toItem;
			if (
				mongoose.isValidObjectId(id)
			) {
			Project.findOne({ _id: id }, "items")
			.populate({ 
				path: "items"
			  })
			.exec((err, project) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(project) {
						if(fromItem >= 0 && project.items.length >= 1 && (project.items.length - 1) >= fromItem) {
							var savedItem = project.items[fromItem]
							var itemid = project.items[fromItem]._id
							if(savedItem instanceof Item && mongoose.isValidObjectId(itemid)) {
								Project.updateOne({ 
									"items" : { $in : [itemid] } 
								}, { 
									$pullAll : { "items" : [itemid] }
								} , (err, pullStatus) => {
									if(toItem >= 0 && (project.items.length - 1) > toItem && pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
									Project.updateOne(
										{ _id: id },
		   { $push: { items: {$each: [savedItem], $position: toItem } } },
		   { safe: true, upsert: true },
		   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push item. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling item.")
								})
							} else res.send("Problem with saved item or id.")
							
							
						} else res.send("Problem with starting index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		});

		// MOVE ELEMENT UP
		app.put(routesPrefix + "/:id/element/up", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);
			var itemId = req.params.id
			var index = req.body.index;
			if (mongoose.isValidObjectId(itemId)) {
			Item.findOne({ _id: itemId }, "elements")
			.populate({ 
				path: "elements"
			  })
			.exec((err, item) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(item) {
						
						if(index > 0 && item.elements.length > 1 && (item.elements.length - 1) >= index) {
							var savedElement = item.elements[index]
							var elementId = item.elements[index]._id
							if(savedElement instanceof Element && mongoose.isValidObjectId(elementId)) {
								Item.updateOne({ 
									"elements" : { $in : [elementId] } 
								}, { 
									$pullAll : { "elements" : [elementId] }
								} , (err, pullStatus) => {
									if(pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
										var newIndex = index - 1
										Item.updateOne(
											{ _id: itemId },
			   { $push: { elements: {$each: [savedElement], $position: newIndex } } },
			   { safe: true, upsert: true },
			   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				  
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push element. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling element.")
								})
							} else res.send("Problem with saved element or id.")
							
							
						} else res.send("Problem with index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		});

		// MOVE ELEMENT DOWN
		app.put(routesPrefix + "/:id/element/down", async (req, res) => {
			// console.log("REQ PARAMS: ", req.params);
			// console.log("REQ BODY: ", req.body);

			var itemId = req.params.id
			var index = req.body.index;
			if (mongoose.isValidObjectId(itemId)) {
			Item.findOne({ _id: itemId }, "elements")
			.populate({ 
				path: "elements"
			  })
			.exec((err, item) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(item) {
						
						if(index >= 0 && item.elements.length >= 1 && index < (item.elements.length - 1)) {
							// res.send("ok")
							var savedElement = item.elements[index]
							var elementId = item.elements[index]._id
							if(savedElement instanceof Element && mongoose.isValidObjectId(elementId)) {
								// res.send("ok")
								Item.updateOne({ 
									"elements" : { $in : [elementId] } 
								}, { 
									$pullAll : { "elements" : [elementId] }
								} , (err, pullStatus) => {
									if(pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
										var newIndex = index + 1
										Item.updateOne(
											{ _id: itemId },
			   { $push: { elements: {$each: [savedElement], $position: newIndex } } },
			   { safe: true, upsert: true },
			   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				  
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push element. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling element.")
								})
							} else res.send("Problem with saved element or id.")
							
							
						} else res.send("Problem with index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}
		});

		// MOVE ELEMENT
		app.put(routesPrefix + "/:id/element/move", async (req, res) => {
			var itemId = req.params.id
			var fromElement = req.body.fromElement;
			var toElement = req.body.toElement;
			if (
				mongoose.isValidObjectId(itemId)
			) {
			Item.findOne({ _id: itemId }, "elements")
			.populate({ 
				path: "elements"
			  })
			.exec((err, item) => {
				if (err) {
					res.send(err.toString());
					throw err;
				} else {
					if(item) {
						if(fromElement >= 0 && item.elements.length >= 1 && (item.elements.length - 1) >= fromElement) {
							var savedElement = item.elements[fromElement]
							var elementId = item.elements[fromElement]._id
							if(savedElement instanceof Element && mongoose.isValidObjectId(elementId)) {
								Item.updateOne({ 
									"elements" : { $in : [elementId] } 
								}, { 
									$pullAll : { "elements" : [elementId] }
								} , (err, pullStatus) => {
									if(toElement >= 0 && (item.elements.length - 1) > toElement && pullStatus.acknowledged && pullStatus.modifiedCount === 1 && pullStatus.matchedCount === 1) {
									Item.updateOne(
										{ _id: itemId },
		   { $push: { elements: {$each: [savedElement], $position: toElement } } },
		   { safe: true, upsert: true },
		   function (err, pushStatus) {
			   if (err) {
				   res.send(err.toString());
				   throw err;
			   } else {
				if(pushStatus.acknowledged && pushStatus.modifiedCount === 1 && pushStatus.matchedCount === 1) {
					res.send(pushStatus);
				} else res.send("Didn't push element. Something went wrong.")
				   
			   }
		   }
		 );
		} else res.send("Problem with ending index or pulling element.")
								})
							} else res.send("Problem with saved element or id.")
							
							
						} else res.send("Problem with starting index")

					} else res.send("Didn't find project")

				}
			});
		} else {
			res.send("Basic Parameters are undefined!");
		}

		});

	// 	// CUT ITEM
	// 	app.put("/:id/item/cut", async (req, res) => {
	// 		// console.log("REQ PARAMS: ", req.params);
	// 		// console.log("REQ BODY: ", req.body);

	// 		var id = req.params.id;
	// 		var selectedItem = req.body.selectedItem;

	// 		if (id && id !== "undefined" && !isNaN(selectedItem)) {
	// 			// console.log("passed tests")
	// 			db.findOne({ _id: id }, function (err, doc) {
	// 				if (err) {
	// 					res.send(err.toString());
	// 				} else {
	// 					if (doc) {
	// 						const items = doc.items;
	// 						// var preIndexCheck =
	// 						if (selectedItem > 0) {
	// 							items.splice(selectedItem, 1);
	// 							// array_move(items, selectedItem);

	// 							for (var i = 0; i < items.length; ++i) {
	// 								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
	// 								items[i].index = i;
	// 								if (i === items.length - 1) {
	// 									db.update(
	// 										{ _id: id },
	// 										{ $set: { items: items } },
	// 										{},
	// 										function (err, numUpdated) {
	// 											if (err) {
	// 												// console.log("err: ", err)
	// 												res.send(err.toString());
	// 											} else {
	// 												if (numUpdated > 0) {
	// 													res.send(
	// 														numUpdated.toString()
	// 													);
	// 												} else {
	// 													res.send("Didn't update");
	// 												}
	// 											}
	// 										}
	// 									);
	// 								}
	// 							}
	// 						} else {
	// 							res.send(
	// 								`Selected Index of ${selectedItem} doesn't Exist`
	// 							);
	// 						}
	// 						// console.log("before docs name is: ", items[index].name)
	// 					} else {
	// 						res.send(`Project ${id} doesn't Exist`);
	// 					}
	// 				}
	// 			});
	// 		} else {
	// 			res.send("Basic Parameters are undefined!");
	// 		}
	// 	});

	// 	// PASTE ITEM
	// 	app.put("/:id/item/paste", async (req, res) => {
	// 		console.log("REQ PARAMS: ", req.params);
	// 		console.log("REQ BODY: ", req.body);

	// 		var id = req.params.id;
	// 		var selectedItem = req.body.selectedItem;
	// 		var item = req.body.item;

	// 		if (id && id !== "undefined" && !isNaN(selectedItem) && item) {
	// 			// console.log("passed tests")
	// 			db.findOne({ _id: id }, function (err, doc) {
	// 				if (err) {
	// 					res.send(err.toString());
	// 				} else {
	// 					if (doc) {
	// 						const items = doc.items;
	// 						// var preIndexCheck =
	// 						if (selectedItem > 0) {
	// 							items.splice(selectedItem, 0, item);
	// 							// array_move(items, selectedItem);

	// 							for (var i = 0; i < items.length; ++i) {
	// 								// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
	// 								items[i].index = i;
	// 								if (i === items.length - 1) {
	// 									db.update(
	// 										{ _id: id },
	// 										{ $set: { items: items } },
	// 										{},
	// 										function (err, numUpdated) {
	// 											if (err) {
	// 												// console.log("err: ", err)
	// 												res.send(err.toString());
	// 											} else {
	// 												if (numUpdated > 0) {
	// 													res.send(
	// 														numUpdated.toString()
	// 													);
	// 												} else {
	// 													res.send("Didn't update");
	// 												}
	// 											}
	// 										}
	// 									);
	// 								}
	// 							}
	// 						} else {
	// 							res.send(
	// 								`Selected Index of ${selectedItem} doesn't Exist`
	// 							);
	// 						}
	// 						// console.log("before docs name is: ", items[index].name)
	// 					} else {
	// 						res.send(`Project ${id} doesn't Exist`);
	// 					}
	// 				}
	// 			});
	// 		} else {
	// 			res.send("Basic Parameters are undefined!");
	// 		}
	// 	});

	// 	// CUT ELEMENT
	// 	app.put("/:id/element/cut", async (req, res) => {
	// 		// console.log("REQ PARAMS: ", req.params);
	// 		// console.log("REQ BODY: ", req.body);

	// 		var id = req.params.id;
	// 		var selectedItem = req.body.selectedItem;
	// 		var selectedElement = req.body.selectedElement;

	// 		// function array_move(arr, fromIndex) {
	// 		// 	var element = arr[fromIndex];
	// 		// 	arr.splice(fromIndex, 1);
	// 		// 	arr.splice(fromIndex + 1, 0, element);
	// 		// }

	// 		if (
	// 			id &&
	// 			id !== "undefined" &&
	// 			!isNaN(selectedItem) &&
	// 			!isNaN(selectedElement)
	// 		) {
	// 			// console.log("passed tests")
	// 			db.findOne({ _id: id }, function (err, doc) {
	// 				if (err) {
	// 					res.send(err.toString());
	// 				} else {
	// 					if (doc) {
	// 						const items = doc.items;
	// 						var preIndexCheck = items.length - 1;
	// 						// console.log("selectedItem is: ", selectedItem)
	// 						// console.log("preIndexCheck is: ", preIndexCheck)
	// 						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
	// 						if (selectedItem <= preIndexCheck && selectedItem >= 0) {
	// 							// CHECK THAT INDEX ISN' ABOVE LENGTH
	// 							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
	// 							var elementIndexCheck =
	// 								items[selectedItem].elements.length - 1;
	// 							// var trueLength = items[selectedItem].elements.length - 1
	// 							// console.log("elements are: ", elementsIndexCheck)
	// 							if (selectedElement <= elementIndexCheck) {

	// 								// console.log("removed element arraybefore  is: ", items[selectedItem].elements.length)
	// 								items[selectedItem].elements.splice(selectedElement, 1);
	// 								// console.log("removed element array after  is: ", items[selectedItem].elements.length)
	// 								// console.log("newitems length is: ", newItems.length)

	// 								for (
	// 									var i = 0;
	// 									i < items[selectedItem].elements.length;
	// 									++i
	// 								) {
	// 									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
	// 									items[selectedItem].elements[i].index = i;
	// 									// console.log("index is: ", i, "and items length is: ", items[selectedItem].elements.length)
	// 									// console.log("items length is : ", items.length)
	// 									if (i === items[selectedItem].elements.length - 1) {
	// 										// console.log("at last of update!")
	// 										db.update(
	// 											{ _id: id },
	// 											{ $set: { items: items } },
	// 											{},
	// 											function (err, numUpdated) {
	// 												if (err) {
	// 													// console.log("err: ", err)
	// 													res.send(err.toString());
	// 												} else {
	// 													if (numUpdated > 0) {
	// 														res.send(
	// 															numUpdated.toString()
	// 														);
	// 													} else {
	// 														res.send(
	// 															"Didn't update"
	// 														);
	// 													}
	// 												}
	// 											}
	// 										);
	// 									}
	// 								}
	// 							} else {
	// 								res.send(
	// 									`Selected Index of element ${selectedElement} doesn't Exist`
	// 								);
	// 							}
	// 							// items.splice(selectedItem, 1);
	// 						} else {
	// 							res.send(
	// 								`Selected Index of item ${selectedItem} doesn't Exist`
	// 							);
	// 						}
	// 						// console.log("before docs name is: ", items[index].name)
	// 					} else {
	// 						res.send(`Project ${id} doesn't Exist`);
	// 					}
	// 				}
	// 			});
	// 		} else {
	// 			res.send("Basic Parameters are undefined!");
	// 		}
	// 	});

	// 	// PASTE ELEMENT
	// 	app.put("/:id/element/paste", async (req, res) => {
	// 		console.log("REQ PARAMS: ", req.params);
	// 		console.log("REQ BODY: ", req.body);

	// 		var id = req.params.id;
	// 		var selectedItem = req.body.selectedItem;
	// 		var selectedElement = req.body.selectedElement;
	// 		var element = req.body.element;

	// 		// function array_move(arr, fromIndex) {
	// 		// 	var element = arr[fromIndex];
	// 		// 	arr.splice(fromIndex, 1);
	// 		// 	arr.splice(fromIndex + 1, 0, element);
	// 		// }

	// 		if (
	// 			id &&
	// 			id !== "undefined" &&
	// 			!isNaN(selectedItem) &&
	// 			!isNaN(selectedElement) && element
	// 		) {
	// 			// console.log("passed tests")
	// 			db.findOne({ _id: id }, function (err, doc) {
	// 				if (err) {
	// 					res.send(err.toString());
	// 				} else {
	// 					if (doc) {
	// 						const items = doc.items;
	// 						var preIndexCheck = items.length - 1;
	// 						// console.log("selectedItem is: ", selectedItem)
	// 						// console.log("preIndexCheck is: ", preIndexCheck)
	// 						// console.log("test: selectedItem > 0 is: ", selectedItem > 0)
	// 						if (selectedItem <= preIndexCheck && selectedItem >= 0) {
	// 							// CHECK THAT INDEX ISN' ABOVE LENGTH
	// 							// var preElementIndexCheck = items[selectedItem].elements.length === 0 ? 1 : items[selectedItem].elements.length
	// 							var elementIndexCheck =
	// 								items[selectedItem].elements.length - 1;
	// 							// var trueLength = items[selectedItem].elements.length - 1
	// 							// console.log("elements are: ", elementsIndexCheck)
	// 							if (selectedElement <= elementIndexCheck) {

	// 								// console.log("removed element arraybefore  is: ", items[selectedItem].elements.length)
	// 								items[selectedItem].elements.splice(selectedElement, 0, element);
	// 								// console.log("removed element array after  is: ", items[selectedItem].elements.length)
	// 								// console.log("newitems length is: ", newItems.length)

	// 								for (
	// 									var i = 0;
	// 									i < items[selectedItem].elements.length;
	// 									++i
	// 								) {
	// 									// console.log("i'm at number:", i, " and object's index is: ", items[i].index)
	// 									items[selectedItem].elements[i].index = i;
	// 									// console.log("index is: ", i, "and items length is: ", items[selectedItem].elements.length)
	// 									// console.log("items length is : ", items.length)
	// 									if (i === items[selectedItem].elements.length - 1) {
	// 										// console.log("at last of update!")
	// 										db.update(
	// 											{ _id: id },
	// 											{ $set: { items: items } },
	// 											{},
	// 											function (err, numUpdated) {
	// 												if (err) {
	// 													// console.log("err: ", err)
	// 													res.send(err.toString());
	// 												} else {
	// 													if (numUpdated > 0) {
	// 														res.send(
	// 															numUpdated.toString()
	// 														);
	// 													} else {
	// 														res.send(
	// 															"Didn't update"
	// 														);
	// 													}
	// 												}
	// 											}
	// 										);
	// 									}
	// 								}
	// 							} else {
	// 								res.send(
	// 									`Selected Index of element ${selectedElement} doesn't Exist`
	// 								);
	// 							}
	// 							// items.splice(selectedItem, 1);
	// 						} else {
	// 							res.send(
	// 								`Selected Index of item ${selectedItem} doesn't Exist`
	// 							);
	// 						}
	// 						// console.log("before docs name is: ", items[index].name)
	// 					} else {
	// 						res.send(`Project ${id} doesn't Exist`);
	// 					}
	// 				}
	// 			});
	// 		} else {
	// 			res.send("Basic Parameters are undefined!");
	// 		}
	// 	});
	

	
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
	const randomName = shortid.generate();
	const MAX_CG_FILES = 1;
	const CG_LIMIT_FILE_SIZE = 1000000000;
	const cgAllowedTypes = [
		"image/jpeg",
		"image/png",
		"video/mp4",
		"video/webm",
	];
	const MAX_BOX_FILES = 1;
	const BOX_LIMIT_FILE_SIZE = 1000000000;
	const boxAllowedTypes = ["image/jpeg", "image/png", "video/mp4"];
	const MAX_PROMO_FILES = 1;
	const PROMO_LIMIT_FILE_SIZE = 1000000000;
	const promoAllowedTypes = ["image/jpeg", "image/png", "video/mp4"];

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
			if (projectName === "temp") {
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
			res.status(422).json({
				error: `MP4, Webm, PNG or JPEG are allowed!`,
			});
			return;
		}
		if (err.code === "CG_LIMIT_FILE_SIZE") {
			res.status(422).json({
				error: `Too large. Max size allowed ${
					CG_LIMIT_FILE_SIZE / 1000000
				}`,
			});
			return;
		}
	});
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
			if (projectName === "temp") {
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
				error: `Too large. Max size allowed ${
					BOX_LIMIT_FILE_SIZE / 1000000
				}`,
			});
			return;
		}
	});
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
			if (projectName === "temp") {
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
				error: `Too large. Max size allowed ${
					PROMO_LIMIT_FILE_SIZE / 1000000
				}`,
			});
			return;
		}
	});
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
