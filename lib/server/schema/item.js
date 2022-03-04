"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const itemSchema = new Schema({
	project: { type: Schema.Types.ObjectId, ref: "Project" },
	
	// index: {
	// 	type: Number,
	// 	default: 0
	// },
	name: {
		type: String,
		Required: true
	},
	expanded: { type: Boolean, default: false },
	options: { type: Boolean, default: false },
	elements: [
		{
			type: Schema.Types.ObjectId,
			ref: "Element"
		}
	],
	createdAt: {
		type: Date,
		default: () => new Date()
	},
	updatedAt: {
		type: Date,
		default: () => new Date()
	}
});

module.exports = { itemSchema };
