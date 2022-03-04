"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const tickerElementSchema = new Schema({
	item: { type: Schema.Types.ObjectId, ref: "Item" },
	uid: {
		type: String,
		Required: true,
		default: ""
	},
	// index: {
	// 	type: Number,
	// 	default: 0
	// },
	type: {
		type: String,
		default: "Live"
	},
	name: {
		type: String,
		Required: true,
		default: ""
	},
	tick: {
		type: Number,
		Required: true,
		default: 3
	},
	data: {
		type: Array,
		Required: true,
		default: []
	},
	effect: {
		type: String,
		Required: true,
		default: "Wipe"
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

module.exports = { tickerElementSchema };