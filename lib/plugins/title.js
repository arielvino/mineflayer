module.exports = inject
function inject (bot) {
  const ChatMessage = require('prismarine-chat')(bot.registry)

  // Title text is a chat component: JSON before 1.20.3, NBT after. Decode it like
  // chat, so styled titles and text in "extra" come out as their plain text.
  function parseTitle (text) {
    return ChatMessage.fromNotch(text).toString()
  }

  if (bot.supportFeature('titleUsesLegacyPackets')) {
    bot._client.on('title', (packet) => {
      if (packet.action === 0) bot.emit('title', parseTitle(packet.text), 'title')
      else if (packet.action === 1) bot.emit('title', parseTitle(packet.text), 'subtitle')
      else if (packet.action === 2) bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut)
      else if (packet.action === 3) {
        if (packet.fadeIn !== undefined) bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut)
        else bot.emit('title_clear')
      } else if (packet.action === 4) bot.emit('title_clear')
    })
  } else if (bot.supportFeature('titleUsesNewPackets')) {
    bot._client.on('set_title_text', (packet) => bot.emit('title', parseTitle(packet.text), 'title'))
    bot._client.on('set_title_subtitle', (packet) => bot.emit('title', parseTitle(packet.text), 'subtitle'))
    bot._client.on('set_title_time', (packet) => {
      if (typeof packet.fadeIn === 'number' && typeof packet.stay === 'number' && typeof packet.fadeOut === 'number') {
        bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut)
      }
    })
    bot._client.on('clear_titles', () => bot.emit('title_clear'))
  }
}
