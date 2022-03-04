"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const superElementSchema = new Schema({
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
		default: "Super"
	},
	name: {
		type: String,
		default: "",
		Required: true
	},
	position: {
		type: String,
		default: ""
	},
	person: {
		type: String,
		default: "",
		Required: true
	},
	title: {
		type: String,
		default: ""
	},
	onPhone: { type: Boolean, default: false },
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

module.exports = { superElementSchema };