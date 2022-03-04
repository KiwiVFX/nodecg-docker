"use strict";

const mongoose = require("mongoose");

const { projectSchema } = require("./project");
const Project = mongoose.model("Project", projectSchema);

const { itemSchema } = require("./item");
const Item = mongoose.model("Item", itemSchema);


// const { superElementSchema } = require("./elements/super");
// const { stripeElementSchema } = require("./elements/stripe");
// const { boxElementSchema } = require("./elements/box");
// const { CGElementSchema } = require("./elements/cg");
// const { fingerElementSchema } = require("./elements/finger");
// const { counterElementSchema } = require("./elements/counter");
// const { liveElementSchema } = require("./elements/live");
// const { tickerElementSchema } = require("./elements/ticker");
// const { rollerElementSchema } = require("./elements/roller");
// const { promoElementSchema } = require("./elements/promo");
const { elementSchema } = require("./element");

// const Super = mongoose.model("Super", superElementSchema);
// const Stripe = mongoose.model("Stripe", stripeElementSchema);
// const Box = mongoose.model("Box", boxElementSchema);
// const CG = mongoose.model("CG", CGElementSchema);
// const Finger = mongoose.model("Finger", fingerElementSchema);
// const Counter = mongoose.model("Counter", counterElementSchema);
// const Live = mongoose.model("Live", liveElementSchema);
// const Ticker = mongoose.model("Ticker", tickerElementSchema);
// const Roller = mongoose.model("Roller", rollerElementSchema);
// const Promo = mongoose.model("Promo", promoElementSchema);
const Element = mongoose.model("Element", elementSchema);

module.exports = {
	Project,
	Item,
	Element,
	// Super,
	// Stripe,
	// Box,
	// CG,
	// Finger,
	// Counter,
	// Live,
	// Ticker,
	// Roller,
	// Promo
};