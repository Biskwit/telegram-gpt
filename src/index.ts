
import config from "config";
import * as log4js from "log4js";
import TelegramBot from "node-telegram-bot-api";

import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";

const bot = new TelegramBot(config.get("telegram.apiKey"), { polling: true })

const users: Array<number> = config.get("telegram.users")

const logger = log4js.getLogger(`server`)
logger.level = config.get("log.level")

const categories = { default: { appenders: ['everything'], level: 'info' } }
categories[`lyrics-bot`] = {
  appenders: ['everything'],
  level: 'info'
}
log4js.configure({
  appenders: {
    everything: { type: 'stdout' }
  },
  categories: categories
})

let historic: ChatCompletionRequestMessage[] = [
  {
    role: "system",
    content: `You are a helpful assistant.`
  },
]

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text == '/start') {
    bot.sendMessage(users[0], `new user ${msg.from.id} (${msg.from.username ?? 'unknown'})`) // notify admin
    return
  }
  logger.info(`${msg.reply_to_message?.text ?? 'no reply'} -> ${msg.text}`)
  logger.info(`Received message from ${msg.from.id}`)
  if (!users.includes(msg.from.id)) return
  if (msg.text == '/reset') {
    bot.sendMessage(chatId, `Resetting...`)
    historic = [
      {
        role: "system",
        content: `You are a helpful assistant.`
      },
    ]
    return
  } else {
    try {
      historic.push({
        role: "user",
        content: msg.text
      })
      const configuration = new Configuration({
        apiKey: config.get("openai.apiKey"),
      });
      const openai = new OpenAIApi(configuration);

      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: historic,
        stream: false,
        temperature: 0.4,
        max_tokens: 2048
      });
      bot.sendMessage(chatId, response.data.choices[0].message.content, { parse_mode: "Markdown" });
      historic.push({
        role: "assistant",
        content: response.data.choices[0].message.content
      })
    } catch (error) {
      logger.error(error)
    }
  }

});


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