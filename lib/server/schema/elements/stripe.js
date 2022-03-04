"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const stripeElementSchema = new Schema({
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
		default: "Stripe"
	},
	name: {
		type: String,
		Required: true
	},
	main: {
		type: String,
		Required: true,
		default: ""
	},
	sub: {
		type: String,
		default: ""
	},
	titleSize: {
		type: String,
		Required: true,
		default: "Medium"
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

module.exports = { stripeElementSchema };