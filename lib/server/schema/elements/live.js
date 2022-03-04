"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const liveElementSchema = new Schema({
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
	main: {
		type: String,
		Required: true,
		default: "LIVE"
	},
	location: {
		type: String,
		default: ""
	},
	color: {
		type: String,
		// Required: true,
		default: "#ff0000"
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

module.exports = { liveElementSchema };