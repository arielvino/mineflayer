const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const BlockFaces = require('prismarine-world').iterators.BlockFace
const { Vec3 } = require('vec3')
const { getPlayerActionIds } = require('../playerActionIds')

module.exports = inject

function inject (bot) {
  const digStatus = getPlayerActionIds(bot)
  let swingInterval = null
  let waitTimeout = null

  let diggingTask = createDoneTask()

  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  async function dig (block, forceLook, digFace) {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block')
    }

    if (!digFace || typeof digFace === 'function') {
      digFace = 'auto'
    }

    const waitTime = bot.digTime(block)
    if (waitTime === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`)
    }

    bot.targetDigFace = 1 // Default (top)

    if (forceLook !== 'ignore') {
      if (digFace?.x || digFace?.y || digFace?.z) {
        // Determine the block face the bot should mine
        if (digFace.x) {
          bot.targetDigFace = digFace.x > 0 ? BlockFaces.EAST : BlockFaces.WEST
        } else if (digFace.y) {
          bot.targetDigFace = digFace.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM
        } else if (digFace.z) {
          bot.targetDigFace = digFace.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
        }
        await bot.lookAt(
          block.position.offset(0.5, 0.5, 0.5).offset(digFace.x * 0.5, digFace.y * 0.5, digFace.z * 0.5),
          forceLook
        )
      } else if (digFace === 'raycast') {
        // Check faces that could be seen from the current position. If the delta is smaller then 0.5 that means the
        // bot can most likely not see the face as the block is 1 block thick
        // this could be false for blocks that have a smaller bounding box than 1x1x1
        const dx = bot.entity.position.x - (block.position.x + 0.5)
        const dy = bot.entity.position.y + bot.entity.eyeHeight - (block.position.y + 0.5)
        const dz = bot.entity.position.z - (block.position.z + 0.5)
        // Check y first then x and z
        const visibleFaces = {
          y: Math.sign(Math.abs(dy) > 0.5 ? dy : 0),
          x: Math.sign(Math.abs(dx) > 0.5 ? dx : 0),
          z: Math.sign(Math.abs(dz) > 0.5 ? dz : 0)
        }
        const validFaces = []
        const closerBlocks = []
        for (const i in visibleFaces) {
          if (!visibleFaces[i]) continue // skip as this face is not visible
          // target position on the target block face. -> 0.5 + (current face) * 0.5
          const targetPos = block.position.offset(
            0.5 + (i === 'x' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'y' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'z' ? visibleFaces[i] * 0.5 : 0)
          )
          const startPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
          const rayBlock = bot.world.raycast(startPos, targetPos.clone().subtract(startPos).normalize(), 5)
          if (rayBlock) {
            const rayPos = rayBlock.position
            // The ray hit the block itself: this face is in view. Checked before the distances,
            // which are equal when the ray hits the face at the aimed point, so rounding alone
            // can put the hit closer and make the block look like it is in its own way.
            if (
              rayPos.x === block.position.x &&
              rayPos.y === block.position.y &&
              rayPos.z === block.position.z
            ) {
              validFaces.push({
                face: rayBlock.face,
                targetPos: rayBlock.intersect
              })
            } else if (startPos.distanceTo(rayBlock.intersect) < startPos.distanceTo(targetPos)) {
              // Another block is in the way
              closerBlocks.push(rayBlock)
            }
          }
        }

        if (validFaces.length > 0) {
          // Chose closest valid face
          let closest
          let distSqrt = 999
          for (const i in validFaces) {
            const tPos = validFaces[i].targetPos
            const cDist = new Vec3(tPos.x, tPos.y, tPos.z).distanceSquared(
              bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
            )
            if (distSqrt > cDist) {
              closest = validFaces[i]
              distSqrt = cDist
            }
          }
          await bot.lookAt(closest.targetPos, forceLook)
          bot.targetDigFace = closest.face
        } else if (closerBlocks.length === 0 && block.shapes.length === 0) {
          // no other blocks were detected and the block has no shapes.
          // The block in question is replaceable (like tall grass) so we can just dig it
          // TODO: do AABB + ray intercept check to this position for digFace.
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
        } else {
          // Block is obstructed return error?
          throw new Error('Block not in view')
        }
      } else {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
      }
    }

    // In vanilla the client will cancel digging the current block once the other block is at the crosshair.
    // Todo: don't wait until lookAt is at middle of the block, but at the edge of it.
    if (bot.targetDigBlock) bot.stopDigging()

    diggingTask = createTask()
    const currentBlock = block
    const eventName = `blockUpdate:${block.position}`
    // Dig progress builds up tick by tick at that tick's speed, as in the vanilla client. A dig
    // timed once at the start sends "finish" too early when the bot leaves the ground or gets its
    // eyes under water meanwhile: the server rates the dig at the moment "finish" arrives, then
    // delays the break or never makes it.
    let progress = 0
    let lastTick = performance.now()
    // The finish packet the server has not answered yet, and how many it has turned down.
    let finishSequence = null
    let rejected = 0
    let replyTimeout = null
    let instantTimeout = null

    function startDigging () {
      bot._client.write('block_dig', {
        status: digStatus.start,
        location: block.position,
        face: bot.targetDigFace, // default face is 1 (top)
        sequence: bot._nextSequence()
      })
      progress = 0
      lastTick = performance.now()
      finishSequence = null
    }

    function stopTimers () {
      clearInterval(swingInterval)
      clearInterval(waitTimeout)
      clearTimeout(replyTimeout)
      clearTimeout(instantTimeout)
      swingInterval = null
      waitTimeout = null
      replyTimeout = null
      instantTimeout = null
      bot._client.removeListener('acknowledge_player_digging', onAcknowledge)
    }

    startDigging()
    bot.targetDigBlock = block
    bot.swingArm()
    swingInterval = setInterval(() => {
      bot.swingArm()
    }, 350)
    waitTimeout = setInterval(digTick, 50)
    if (waitTime === 0) instantTimeout = setTimeout(finishDigging, 0)

    function digTick () {
      if (finishSequence !== null) return
      const now = performance.now()
      progress += (now - lastTick) / bot.digTime(block)
      lastTick = now
      if (progress >= 1) finishDigging()
    }

    function finishDigging () {
      if (!bot.targetDigBlock) return
      finishSequence = bot._nextSequence()
      bot._client.write('block_dig', {
        status: digStatus.finish,
        location: bot.targetDigBlock.position,
        face: bot.targetDigFace, // always the same as the start face
        sequence: finishSequence
      })
      bot.lastDigTime = performance.now()
      // The dig is done when the server says the block is gone, not before: a server that turns
      // the finish down keeps the block. It answers with an acknowledgement (1.14+); older servers
      // send nothing, so a silence also counts as a refusal.
      clearTimeout(replyTimeout)
      replyTimeout = setTimeout(onRefused, 2000)
    }

    function onAcknowledge (packet) {
      if (finishSequence === null) return
      if (packet.sequenceId !== undefined) {
        // 1.19+: the server sends the block's update before the acknowledgement, so a block
        // still standing here was not broken.
        if (packet.sequenceId < finishSequence) return
        if (bot.blockAt(block.position)?.type === block.type) onRefused()
        return
      }
      // 1.14-1.18: the acknowledgement comes first and carries the state the block is left in.
      if (!packet.location || !block.position.equals(new Vec3(packet.location.x, packet.location.y, packet.location.z))) return
      if (packet.status !== digStatus.finish) return
      if (bot.registry.blocksByStateId[packet.block]?.id === block.type) onRefused()
    }

    function onRefused () {
      if (!bot.targetDigBlock || finishSequence === null) return
      clearTimeout(replyTimeout)
      replyTimeout = null
      if (++rejected > 5) {
        bot.stopDigging()
        return
      }
      // As a player holding the button would, dig it again.
      startDigging()
    }
    bot._client.on('acknowledge_player_digging', onAcknowledge)

    bot.on(eventName, onBlockUpdate)

    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return

      // Replicate the odd vanilla cancellation face value.
      // When the cancellation is because of a new dig request on another block it's the same as the new dig start face. In all other cases it's 0.
      const stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)
      const cancellationDiggingFace = !stoppedBecauseOfNewDigRequest ? bot.targetDigFace : 0

      bot.removeListener(eventName, onBlockUpdate)
      stopTimers()
      bot._client.write('block_dig', {
        status: digStatus.abort,
        location: bot.targetDigBlock.position,
        face: cancellationDiggingFace,
        sequence: 0
      })
      const block = bot.targetDigBlock
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      bot.emit('diggingAborted', block)
      bot.stopDigging = noop
      diggingTask.cancel(new Error(rejected > 5 ? 'Digging aborted: the server did not break the block' : 'Digging aborted'))
    }

    function onBlockUpdate (oldBlock, newBlock) {
      // vanilla server never actually interrupt digging, but some server send block update when you start digging
      // so ignore an update that leaves the block in place. A broken block turns to air, or to water
      // when it was waterlogged.
      // All block update listeners receive (null, null) when the world is unloaded. So newBlock can be null.
      if (!newBlock || newBlock.type === block.type) return
      bot.removeListener(eventName, onBlockUpdate)
      stopTimers()
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      bot.emit('diggingCompleted', newBlock)
      diggingTask.finish()
    }

    await diggingTask.promise
  }

  bot.on('death', () => {
    try {
      bot.removeAllListeners('diggingAborted')
      bot.removeAllListeners('diggingCompleted')
      bot.stopDigging()
    } catch (_) {}
  })

  function canDigBlock (block) {
    return (
      block &&
      block.diggable &&
      block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1
    )
  }

  function digTime (block) {
    let type = null
    let enchantments = []

    // Retrieve currently held item ID and active enchantments from heldItem
    const currentlyHeldItem = bot.heldItem
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type
      enchantments = currentlyHeldItem.enchants
    }

    // Append helmet enchantments (because Aqua Affinity actually affects dig speed)
    const headEquipmentSlot = bot.getEquipmentDestSlot('head')
    const headEquippedItem = bot.inventory.slots[headEquipmentSlot]
    if (headEquippedItem) {
      const helmetEnchantments = headEquippedItem.enchants
      enchantments = enchantments.concat(helmetEnchantments)
    }

    const creative = bot.game.gameMode === 'creative'
    return block.digTime(
      type,
      creative,
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects
    )
  }

  bot._getBlockAtEyeLevel = () => bot.entity.position && bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
  bot.dig = dig
  bot.stopDigging = noop
  bot.canDigBlock = canDigBlock
  bot.digTime = digTime
}

function noop (err) {
  if (err) throw err
}
