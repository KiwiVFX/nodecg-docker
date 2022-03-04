"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const boxElementSchema = new Schema({
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
		default: "CG"
	},
	name: {
		type: String,
		Required: true
	},
	src: {
		type: String,
		Required: true,
		default: ""
	},
	assetType: {
		type: String,
		default: null
	},
	effect: {
		type: String,
		Required: true,
		default: "Push"
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

module.exports = { boxElementSchema };