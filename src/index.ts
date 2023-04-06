
import config from "config";
import * as log4js from "log4js";
import TelegramBot from "node-telegram-bot-api";
import https from "https";
import fs, { createReadStream } from "fs";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath.path);

import { loadJSON, saveJSON } from "./utils";

import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";

const bot = new TelegramBot(config.get("telegram.apiKey"), { polling: true })
const configuration = new Configuration({
	apiKey: config.get("openai.apiKey"),
});
const openai = new OpenAIApi(configuration);

const users = loadJSON("./data/users.json")
const conversations = () => {
	let conv = []
	for (const user of users) {
		conv[user] = loadJSON(`./data/${user}.json`)
	}
	return conv
}
const admin: number = config.get("telegram.admin")

const logger = log4js.getLogger(`server`)
logger.level = config.get("log.level")

const categories = { default: { appenders: ['everything'], level: config.get("log.level") as string } }
categories[`gpt-bot`] = {
	appenders: ['everything'],
	level: config.get("log.level")
}

log4js.configure({
	appenders: {
		everything: { type: 'stdout' }
	},
	categories: categories
})


bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	const isReply = msg.reply_to_message != undefined
	const isCommand = msg.text?.startsWith('/')

	if (isCommand) {
		if (msg.text.startsWith('/start')) {
			bot.sendMessage(users[0], `new user ${msg.from.id} (${msg.from.username ?? 'unknown'})`) // notify admin
			return
		}

		if (msg.text.startsWith('/add')) {
			const userToAdd = parseInt(msg.text.split(' ')[1])
			if (users.includes(userToAdd)) return
			if (msg.from.id != admin) return
			users.push(userToAdd)
			saveJSON("./data/users.json", users)
			bot.sendMessage(admin, `Added user ${userToAdd}`)
			bot.sendMessage(userToAdd, `You are now authorized to use the bot.`)
			return
		}
	} else {
		logger.info(`Received message from ${msg.from.id}`)
		if (!users.includes(msg.from.id)) return
		let userConversation = conversations()[msg.from.id]
		try {
			if (msg.voice) {
				if (!isReply) {
					logger.info(`${msg.voice.file_id}`)
					const tgFile = await bot.getFile(msg.voice.file_id)
					const file = fs.createWriteStream(`./data/${msg.from.id}.oga`);
					const mp3File = fs.createWriteStream(`./data/${msg.from.id}.mp3`);
					https.get(`https://api.telegram.org/file/bot${config.get("telegram.apiKey")}/${tgFile.file_path}`, (res) => {
						res.pipe(file)
						file.on("finish", () => {
							ffmpeg()
								.input(`./data/${msg.from.id}.oga`)
								.toFormat("mp3")
								.on('end', async () => {
									const response = await openai.createTranscription(fs.createReadStream(`./data/${msg.from.id}.mp3`) as any, "whisper-1", undefined, "text", 0.5, "fr")
									fs.unlinkSync(`./data/${msg.from.id}.oga`)
									fs.unlinkSync(`./data/${msg.from.id}.mp3`)
									const NewTopicTranscripted = await bot.sendMessage(chatId, `_${response.data as any}_`, { parse_mode: "Markdown", reply_to_message_id: msg.message_id });
									userConversation.push({
										role: "system",
										content: `${response.data}`,
										id: NewTopicTranscripted.message_id,
										replyTo: null
									})
									const newTopic = await openai.createChatCompletion({
										model: "gpt-3.5-turbo",
										messages: [
											{
												role: "system",
												content: response.data as any
											}
										],
										stream: false,
										temperature: 0.5,
										max_tokens: 2048
									});
									let replyMsg: any
									if (newTopic.data.choices[0].message.content.length > 4000) {
										replyMsg = await bot.sendMessage(chatId, newTopic.data.choices[0].message.content.substring(0, 4000), { parse_mode: "Markdown", reply_to_message_id: NewTopicTranscripted.message_id });
										await bot.sendMessage(chatId, newTopic.data.choices[0].message.content.substring(4000), { parse_mode: "Markdown", reply_to_message_id: NewTopicTranscripted.message_id });
									} else {
										replyMsg = await bot.sendMessage(chatId, newTopic.data.choices[0].message.content, { parse_mode: "Markdown", reply_to_message_id: NewTopicTranscripted.message_id });
									}
									userConversation.push({
										role: "assistant",
										content: newTopic.data.choices[0].message.content,
										id: replyMsg.message_id,
										replyTo: NewTopicTranscripted.message_id
									})
									saveJSON(`./data/${msg.from.id}.json`, userConversation)
								})
								.pipe(mp3File, { end: true });
							file.close();
						})

					});
				}
			} else {
				if (isReply) {
					// it's a reply, so we need to find the thread
					userConversation.push({
						role: "user",
						content: msg.text,
						id: msg.message_id,
						replyTo: msg.reply_to_message.message_id
					})

					const thread = getThread(userConversation, msg.reply_to_message.message_id).map(msg => {
						return {
							role: msg.role,
							content: msg.content
						}
					})

					const response = await openai.createChatCompletion({
						model: "gpt-3.5-turbo",
						messages: [...thread, {
							role: "user",
							content: msg.text,
						}],
						stream: false,
						temperature: 0.5,
						max_tokens: 2048
					});

					const replyMsg = await bot.sendMessage(chatId, response.data.choices[0].message.content, { parse_mode: "Markdown", reply_to_message_id: msg.message_id });
					userConversation.push({
						role: "assistant",
						content: response.data.choices[0].message.content,
						id: replyMsg.message_id,
						replyTo: msg.message_id
					})
					saveJSON(`./data/${msg.from.id}.json`, userConversation)
				} else {
					// new topic
					userConversation.push({
						role: "system",
						content: msg.text,
						id: msg.message_id,
						replyTo: null
					})
					const response = await openai.createChatCompletion({
						model: "gpt-3.5-turbo",
						messages: [
							{
								role: "system",
								content: msg.text
							}
						],
						stream: false,
						temperature: 0.5,
						max_tokens: 2048
					});

					let replyMsg: any
					if (response.data.choices[0].message.content.length > 4000) {
						replyMsg = await bot.sendMessage(chatId, response.data.choices[0].message.content.substring(0, 4000), { parse_mode: "Markdown", reply_to_message_id: msg.message_id });
						await bot.sendMessage(chatId, response.data.choices[0].message.content.substring(4000), { parse_mode: "Markdown", reply_to_message_id: msg.message_id });
					} else {
						replyMsg = await bot.sendMessage(chatId, response.data.choices[0].message.content, { parse_mode: "Markdown", reply_to_message_id: msg.message_id });
					}
					userConversation.push({
						role: "assistant",
						content: response.data.choices[0].message.content,
						id: replyMsg.message_id,
						replyTo: msg.message_id
					})
					saveJSON(`./data/${msg.from.id}.json`, userConversation)
				}
			}

		} catch (error) {
			logger.error(error)
		}
	}
});

function getThread(userConversation, id) {
	const thread = [];
	let currentId = id;

	while (currentId) {
		const message = userConversation.find(msg => msg.id === currentId);
		if (!message) break;

		thread.unshift(message);
		currentId = message.replyTo;
	}

	return thread;
}


// const stream = resStream.data as any as Readable;
// stream.on('data', (chunk) => {
//   try {
//     // Parse the chunk as a JSON object
//     const chunkStrs = chunk
//       .toString()
//       .split('\n')
//       .filter((item) => item.trim() != '')
//       .map((item) => {
//         return item
//           .trim()
//           .replace(/^data: /, '')
//           .trim();
//       });

//     for (const chunkStr of chunkStrs) {
//       if (chunkStr.match('\\[DONE\\]')) {
//         response.end();
//       } else {
//         try {
//           const data = JSON.parse(chunkStr);
//           // Write the text from the response to the output stream
//           response.write(data.choices?.[0]?.delta?.content ?? '');
//         } catch (e) {
//           console.log(`***${chunkStr}***`, e);
//         }
//       }
//     }