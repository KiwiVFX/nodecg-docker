"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const counterElementSchema = new Schema({
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
		default: "Counter"
	},
	name: {
		type: String,
		Required: true,
		default: ""
	},
	rtl: {
		type: Boolean,
		Required: true,
		default: false
	},
	counterType: {
		type: String,
		Required: true,
		default: "down"
	},
	amount: {
		type: Number,
		Required: true,
		default: 5
	},
	text: {
		type: String,
		default: ""
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

module.exports = { counterElementSchema };