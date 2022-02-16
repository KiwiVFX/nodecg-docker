'use strict';

const path = require('path');
const express = require('express');
const app = express();
const {config} = require('../config');
const cookieParser = require('cookie-parser');
const fetch = require('make-fetch-happen');
const session = require('express-session');
const NedbStore = require('express-nedb-session')(session);
const passport = require('passport');
const log = require('../logger')('nodecg/lib/login');
const protocol = ((config.ssl && config.ssl.enabled) || config.login.forceHttpsReturn) ? 'https' : 'http';

// 2016-03-26 - Lange: I don't know what these do?
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (config.login.steam && config.login.steam.enabled) {
	const SteamStrategy = require('passport-steam').Strategy;
	passport.use(new SteamStrategy({
		returnURL: `${protocol}://${config.baseURL}/login/auth/steam`,
		realm: `${protocol}://${config.baseURL}/login/auth/steam`,
		apiKey: config.login.steam.apiKey
	}, (identifier, profile, done) => {
		profile.allowed = (config.login.steam.allowedIds.indexOf(profile.id) > -1);

		if (profile.allowed) {
			log.info('Granting %s (%s) access', profile.id, profile.displayName);
		} else {
			log.info('Denying %s (%s) access', profile.id, profile.displayName);
		}

		return done(null, profile);
	}));
}

if (config.login.twitch && config.login.twitch.enabled) {
	const TwitchStrategy = require('passport-twitch-helix').Strategy;

	// The "user:read:email" scope is required. Add it if not present.
	let scope = config.login.twitch.scope.split(' ');
	if (scope.indexOf('user:read:email') < 0) {
		scope.push('user:read:email');
	}

	scope = scope.join(' ');

	passport.use(new TwitchStrategy({
		clientID: config.login.twitch.clientID,
		clientSecret: config.login.twitch.clientSecret,
		callbackURL: `${protocol}://${config.baseURL}/login/auth/twitch`,
		scope,
		customHeaders: {'Client-ID': config.login.twitch.clientID}
	}, (accessToken, refreshToken, profile, done) => {
		profile.allowed = config.login.twitch.allowedUsernames.includes(profile.username) ||
			config.login.twitch.allowedIds.includes(profile.id);

		if (profile.allowed) {
			log.info('Granting %s access', profile.username);
			profile.accessToken = accessToken;
			profile.refreshToken = refreshToken;
		} else {
			log.info('Denying %s access', profile.username);
		}

		return done(null, profile);
	}));
}

async function makeDiscordAPIRequest(guild, userID) {
	const res = await fetch(`https://discord.com/api/v8/guilds/${guild.guildID}/members/${userID}`,
		{
			headers: {
				Authorization: `Bot ${guild.guildBotToken}`
			}
		}
	);
	const data = await res.json();
	if (res.status === 200) {
		return [guild, false, data];
	}

	return [guild, true, data];
}

if (config.login.discord && config.login.discord.enabled) {
	const DiscordStrategy = require('passport-discord').Strategy;

	// The "identify" scope is required. Add it if not present.
	let scope = config.login.discord.scope.split(' ');
	if (scope.indexOf('identify') < 0) {
		scope.push('identify');
	}

	// The "guilds" scope is required if allowedGuilds are used. Add it if not present.
	if (scope.indexOf('guilds') < 0 && config.login.discord.allowedGuilds) {
		scope.push('guilds');
	}

	scope = scope.join(' ');
	passport.use(new DiscordStrategy({
		clientID: config.login.discord.clientID,
		clientSecret: config.login.discord.clientSecret,
		callbackURL: `${protocol}://${config.baseURL}/login/auth/discord`,
		scope
	}, async (accessToken, refreshToken, profile, done) => {
		if (config.login.discord.allowedUserIDs && config.login.discord.allowedUserIDs.includes(profile.id)) {
			// Users that are on allowedUserIDs are allowed
			profile.allowed = true;
		} else if (config.login.discord.allowedGuilds) {
			// Get guilds that are specified in the config and that user is in
			const intersectingGuilds = config.login.discord.allowedGuilds.filter(allowedGuild => {
				return profile.guilds.some(profileGuild => profileGuild.id === allowedGuild.guildID);
			});

			const guildRequests = [];

			for (const intersectingGuild of intersectingGuilds) {
				if (!intersectingGuild.allowedRoleIDs || intersectingGuild.allowedRoleIDs.length === 0) {
					// If the user matches any guilds that only have member and not role requirements we do not need to make requests to the discord API
					profile.allowed = true;
				} else {
					// Queue up all requests to the Discord API to improve speed
					guildRequests.push(makeDiscordAPIRequest(intersectingGuild, profile.id));
				}
			}

			if (profile.allowed !== true) {
				const guildsData = await Promise.all(guildRequests);
				for (const [guildWithRoles, err, memberResponse] of guildsData) {
					if (err) {
						log.warn(`Got error while trying to get guild ${guildWithRoles.guildID} ` +
						`(Make sure you're using the correct bot token and guild id): ${JSON.stringify(memberResponse)}`);
						continue;
					}

					const intersectingRoles = guildWithRoles.allowedRoleIDs.filter(allowedRole => memberResponse.roles.includes(allowedRole));
					if (intersectingRoles.length !== 0) {
						profile.allowed = true;
						break;
					}
				}
			}
		} else {
			profile.allowed = false;
		}

		if (profile.allowed) {
			log.info('Granting %s#%s (%s) access', profile.username, profile.discriminator, profile.id);
			// eslint-disable-next-line require-atomic-updates
			profile.accessToken = accessToken;
			// eslint-disable-next-line require-atomic-updates
			profile.refreshToken = refreshToken;
		} else {
			// eslint-disable-next-line require-atomic-updates
			profile.allowed = false;
			log.info('Denying %s#%s (%s) access', profile.username, profile.discriminator, profile.id);
		}

		return done(null, profile);
	}));
}

if (config.login.local && config.login.local.enabled) {
	const {Strategy: LocalStrategy} = require('passport-local');
	const crypto = require('crypto');

	const {sessionSecret, local: {allowedUsers}} = config.login;
	const hashes = crypto.getHashes();

	passport.use(new LocalStrategy({
		usernameField: 'username',
		passwordField: 'password',
		session: false
	}, (username, password, done) => {
		const user = allowedUsers.find(u => u.username === username);
		let allowed = false;

		if (user) {
			const match = user.password.match(/^([^:]+):(.+)$/);
			let expected = user.password;
			let actual = password;

			if (match && hashes.includes(match[1])) {
				expected = match[2];
				actual = crypto
					.createHmac(match[1], sessionSecret)
					.update(actual, 'utf8')
					.digest('hex');
			}

			if (expected === actual) {
				allowed = true;
			}
		}

		log.info('%s %s access using local auth', allowed ? 'Granting' : 'Denying', username);

		return done(null, {
			provider: 'local',
			username,
			allowed
		});
	}));
}

// Express-session no longer uses cookieParser, but NodeCG's util lib does.
app.use(cookieParser(config.login.sessionSecret));
app.use(session({
	secret: config.login.sessionSecret,
	resave: false,
	saveUninitialized: false,
	store: new NedbStore({filename: path.resolve(process.env.NODECG_ROOT, 'db/sessions.db')}),
	cookie: {
		path: '/',
		httpOnly: true,
		secure: config.ssl && config.ssl.enabled
	}
}));

app.use(passport.initialize());
app.use(passport.session());

app.use('/login', express.static(path.join(__dirname, 'public')));
app.set('views', __dirname);

app.get('/login', (req, res) => {
	res.render('public/login.tmpl', {
		user: req.user,
		config
	});
});

app.get('/authError', (req, res) => {
	res.render('public/authError.tmpl', {
		message: req.query.message,
		code: req.query.code,
		viewUrl: req.query.viewUrl
	});
});

app.get('/login/steam', passport.authenticate('steam'));

app.get(
	'/login/auth/steam',
	passport.authenticate('steam', {failureRedirect: '/login'}),
	redirectPostLogin
);

app.get('/login/twitch', passport.authenticate('twitch'));

app.get(
	'/login/auth/twitch',
	passport.authenticate('twitch', {failureRedirect: '/login'}),
	redirectPostLogin
);

app.get('/login/discord', passport.authenticate('discord'));

app.get(
	'/login/auth/discord',
	passport.authenticate('discord', {failureRedirect: '/login'}),
	redirectPostLogin
);

app.get('/login/local', passport.authenticate('local'));

app.post(
	'/login/local',
	passport.authenticate('local', {failureRedirect: '/login'}),
	redirectPostLogin
);

app.get('/logout', (req, res) => {
	app.emit('logout', req.session);
	req.session.destroy(() => {
		res.clearCookie('connect.sid', {path: '/'});
		res.clearCookie('socketToken', {path: '/'});
		res.redirect('/login');
	});
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

function redirectPostLogin(req, res) {
	const url = req.session.returnTo || '/dashboard';
	res.redirect(url);
	app.emit('login', req.session);
}

module.exports = app;
