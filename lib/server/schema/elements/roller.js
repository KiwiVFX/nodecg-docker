"use strict";

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Define collection and schema for Items
const rollerElementSchema = new Schema({
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
		default: "Roller"
	},
	name: {
		type: String,
		Required: true,
		default: ""
	},
	layout: {
		type: String,
		Required: true,
		default: "Lower Third"
	},
	header: {
		type: String,
		default: ""
	},
	headerBold: {
		type: Boolean,
		default: true
	},
	headerSize: {
		type: String,
		default: "40"
	},
	// group1: [
	//   { title: "Title1", name: "Name1" },
	//   { title: "Title2", name: "Name2" },
	//   { title: "Title3", name: "Name3" },
	//   { title: "Title4", name: "Name4" },
	// ],
	// group2: [
	//   { title: "Title5", name: "Name5" },
	//   { title: "Title6", name: "Name6" },
	//   { title: "Title7", name: "Name7" },
	//   { title: "Title8", name: "Name8" },
	// ],
	// group3: [
	//   { title: "Title9", name: "Name9" },
	//   { title: "Title10", name: "Name10" },
	//   { title: "Title11", name: "Name11" },
	//   { title: "Title12", name: "Name12" },
	// ],
	// group4: [
	//   { title: "Title13", name: "Name13" },
	//   { title: "Title14", name: "Name14" },
	//   { title: "Title15", name: "Name15" },
	//   { title: "Title16", name: "Name16" },
	// ],
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

module.exports = { rollerElementSchema };