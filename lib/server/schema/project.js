"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const ShortUniqueId = require("short-unique-id");
const uid = new ShortUniqueId({ length: 8 });
const { itemSchema } = require("./item");

const { superElementSchema } = require("./elements/super");
const { stripeElementSchema } = require("./elements/stripe");
const { boxElementSchema } = require("./elements/box");
const { CGElementSchema } = require("./elements/cg");
const { fingerElementSchema } = require("./elements/finger");
const { counterElementSchema } = require("./elements/counter");
const { liveElementSchema } = require("./elements/live");
const { tickerElementSchema } = require("./elements/ticker");
const { rollerElementSchema } = require("./elements/roller");
const { promoElementSchema } = require("./elements/promo");


// const Item = mongoose.model("Item", itemSchema);
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

const projectSchema = new Schema({
	id: {
		type: Schema.Types.ObjectId,
		Required: true
	},
	name: {
		type: String,
		Required: true
	},
	items: [
		{
			type: Schema.Types.ObjectId,
			ref: "Item",
		  },
	],
	settings: {
		language: { type: String, default: "EN" },
		rtl: { type: Boolean, default: false },
		UIColor: { type: String, default: "#1AA7EC" },
		layout: { type: String, default: "News" },
		debug: { type: Boolean, default: false },
		general: {
			autoSave: { type: Boolean, default: false },
			autoSaveInterval: { type: Number, default: 300 },
			promptAutosave: { type: Boolean, default: true },
			projectsRefreshInterval: { type: Number, default: 60 },
			createNewItemAbove: { type: Boolean, default: true },
			itemArrows: { type: Boolean, default: true }
		},
		hotkeys: {
			basic: {
				cut: { type: String, default: "CTRL + SHIFT + X" },
				copy: { type: String, default: "CTRL + SHIFT + C" },
				paste: { type: String, default: "CTRL + SHIFT + V" },
				delete: { type: String, default: "CTRL + SHIFT + D" }
			},
			inAndOut: {
				insert: { type: String, default: "NumbpadEnter" },
				clearSupers: { type: String, default: "Numpad1" },
				clearStripe: { type: String, default: "Numpad2" },
				clearBox: { type: String, default: "Numpad3" },
				clearCG: { type: String, default: "Numpad4" },
				clearFingers: { type: String, default: "Numpad5" },
				clearCounter: { type: String, default: "Numpad6" },
				clearLive: { type: String, default: "Numpad7" },
				clearTicker: { type: String, default: "Numpad8" },
				clearPromo: { type: String, default: "Numpad9" },
				clearRoller: { type: String, default: "Numpad0" },
				clearAll: { type: String, default: "NumpadDivide" }
			},
			create: {
				newSuper: { type: String, default: "ALT + 1" },
				newStripe: { type: String, default: "ALT + 2" },
				newBox: { type: String, default: "ALT + 3" },
				newCG: { type: String, default: "ALT + 4" },
				newFinger: { type: String, default: "ALT + 5" },
				newCounter: { type: String, default: "ALT + 6" },
				newLive: { type: String, default: "ALT + 7" },
				newTicker: { type: String, default: "ALT + 8" },
				newRoller: { type: String, default: "ALT + 9" },
				newPromo: { type: String, default: "ALT + 0" }
			},
			others: {
				newProject: { type: String, default: "ALT + P" },
				newItem: { type: String, default: "ALT + N" },
				newImport: { type: String, default: "ALT + I" },
				moveElementUp: { type: String, default: "NumpadSubtract" },
				moveElementDown: { type: String, default: "NumpadAdd" }
			}
		}
	},
	createdAt: {
		type: Date,
		default: () => new Date()
	},
	updatedAt: {
		type: Date,
		default: () => new Date()
	}
});

module.exports = { projectSchema };
