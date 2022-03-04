"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const fingerElementSchema = new Schema({
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
		default: "Finger"
	},
	name: {
		type: String,
		Required: true,
		default: ""
	},
	expanded: {
		type: Boolean,
		Required: true,
		default: false
	},
	person: {
		type: String,
		Required: true,
		default: ""
	},
	position: {
		type: String,
		Required: true,
		default: "bottomLeft"
	},
	main: {
		type: String,
		Required: true,
		default: ""
	},
	sub: {
		type: Array,
		default: []
	},
	effect: {
		type: String,
		Required: true,
		default: "Cut"
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

module.exports = { fingerElementSchema };