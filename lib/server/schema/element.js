"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const elementSchema = new Schema({
	item: { type: Schema.Types.ObjectId, ref: "Item" },
	// index: {
	// 	type: Number,
	// 	default: 0
	// },
	type: {
		type: String,
		Required: true,
		default: ""
	},
	name: {
		type: String,
		Required: true,
		default: ""
	},


	position: {
		type: String
	},
	person: {
		type: String
	},
	title: {
		type: String
	},
	onPhone: { type: Boolean },
	main: {
		type: String
	},
	sub: {
		type: String
	},
	titleSize: {
		type: String
	},
	location: {
		type: String
	},
	color: {
		type: String
	},
	counterType: {
		type: String
	},
	amount: {
		type: Number
	},
	tick: {
		type: Number
	},
	data: {
		type: Array
	},
	rtl: {
		type: Boolean
	},
	src: {
		type: String
	},
	text: {
		type: String
	},
	assetType: {
		type: String
	},
	effect: {
		type: String
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

module.exports = { elementSchema };