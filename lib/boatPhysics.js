// Boat movement, ported from the vanilla client. A boat is moved by the client controlling it, which reports
// the result with a serverbound vehicle_move; the server only checks it. Yaw here is Notchian, in degrees.
const { Vec3 } = require('vec3')
const AABB = require('prismarine-physics/lib/aabb')

const GRAVITY = 0.04
const HALF_WIDTH = 1.375 / 2
const HEIGHT = 0.5625
const DEG = Math.PI / 180

// Blocks that hold a water source without being water.
const WATER_PLANTS = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])
const FRICTION = { ice: 0.98, packed_ice: 0.98, frosted_ice: 0.98, blue_ice: 0.989, slime_block: 0.8 }
const DEFAULT_FRICTION = 0.6

function isBoat (entity) {
  return /_(chest_)?(boat|raft)$/.test(entity?.name ?? '')
}

function createState (yaw) {
  return { yaw, velocity: new Vec3(0, 0, 0), deltaRotation: 0, status: null, waterLevel: 0, landFriction: 0 }
}

function boatBB (pos) {
  return new AABB(pos.x - HALF_WIDTH, pos.y, pos.z - HALF_WIDTH, pos.x + HALF_WIDTH, pos.y + HEIGHT, pos.z + HALF_WIDTH)
}

// world: { getBlock(Vec3) }
function inject (world) {
  const cursor = new Vec3(0, 0, 0)
  const blockAt = (x, y, z) => world.getBlock(cursor.set(x, y, z))

  // { source, amount } of the water in a block, or null. amount is in eighths, as in the vanilla fluid state.
  function waterIn (block) {
    if (!block) return null
    if (block.name === 'water') {
      const level = Number(block.getProperties().level ?? block.metadata)
      return { source: level === 0, amount: level === 0 || level >= 8 ? 8 : 8 - level }
    }
    if (WATER_PLANTS.has(block.name) || block.getProperties().waterlogged === true) return { source: true, amount: 8 }
    return null
  }

  // Height of the water surface within the block at (x,y,z): full when water continues above.
  function waterHeight (x, y, z, water) {
    return waterIn(blockAt(x, y + 1, z)) ? 1 : water.amount / 9
  }

  function forBlocks (minX, maxX, minY, maxY, minZ, maxZ, fn) {
    for (let x = minX; x < maxX; x++) {
      for (let y = minY; y < maxY; y++) {
        for (let z = minZ; z < maxZ; z++) {
          if (fn(x, y, z) === true) return true
        }
      }
    }
    return false
  }

  // Boat.checkInWater: is the bottom of the boat below a water surface; records the highest surface.
  function checkInWater (bb, state) {
    let inWater = false
    state.waterLevel = -Infinity
    forBlocks(Math.floor(bb.minX), Math.ceil(bb.maxX), Math.floor(bb.minY), Math.ceil(bb.minY + 0.001),
      Math.floor(bb.minZ), Math.ceil(bb.maxZ), (x, y, z) => {
        const water = waterIn(blockAt(x, y, z))
        if (!water) return
        const surface = y + waterHeight(x, y, z, water)
        state.waterLevel = Math.max(surface, state.waterLevel)
        inWater = inWater || bb.minY < surface
      })
    return inWater
  }

  // Boat.isUnderwater: 'under_water', 'under_flowing_water', or null when the top of the boat is dry.
  function underwaterStatus (bb) {
    const top = bb.maxY + 0.001
    let under = false
    const flowing = forBlocks(Math.floor(bb.minX), Math.ceil(bb.maxX), Math.floor(bb.maxY), Math.ceil(top),
      Math.floor(bb.minZ), Math.ceil(bb.maxZ), (x, y, z) => {
        const water = waterIn(blockAt(x, y, z))
        if (!water || top >= y + waterHeight(x, y, z, water)) return
        if (!water.source) return true
        under = true
      })
    if (flowing) return 'under_flowing_water'
    return under ? 'under_water' : null
  }

  // Boat.getGroundFriction: mean friction of the blocks touching the boat's bottom face, 0 when none do.
  function groundFriction (bb) {
    const bottom = new AABB(bb.minX, bb.minY - 0.001, bb.minZ, bb.maxX, bb.minY, bb.maxZ)
    const x0 = Math.floor(bottom.minX) - 1
    const x1 = Math.ceil(bottom.maxX) + 1
    const y0 = Math.floor(bottom.minY) - 1
    const y1 = Math.ceil(bottom.maxY) + 1
    const z0 = Math.floor(bottom.minZ) - 1
    const z1 = Math.ceil(bottom.maxZ) + 1
    let sum = 0
    let count = 0
    for (let x = x0; x < x1; x++) {
      for (let z = z0; z < z1; z++) {
        const edges = (x === x0 || x === x1 - 1 ? 1 : 0) + (z === z0 || z === z1 - 1 ? 1 : 0)
        if (edges === 2) continue
        for (let y = y0; y < y1; y++) {
          if (edges > 0 && (y === y0 || y === y1 - 1)) continue
          const block = blockAt(x, y, z)
          if (!block || block.name === 'lily_pad') continue
          if (block.shapes.some(s => new AABB(...s).offset(x, y, z).intersects(bottom))) {
            sum += FRICTION[block.name] ?? DEFAULT_FRICTION
            count++
          }
        }
      }
    }
    return count === 0 ? 0 : sum / count
  }

  function getStatus (bb, state) {
    const under = underwaterStatus(bb)
    if (under) {
      state.waterLevel = bb.maxY
      return under
    }
    if (checkInWater(bb, state)) return 'in_water'
    const friction = groundFriction(bb)
    if (friction > 0) {
      state.landFriction = friction
      return 'on_land'
    }
    return 'in_air'
  }

  // Boat.getWaterLevelAbove: the surface above the boat's top, for a boat falling into water.
  function waterLevelAbove (bb) {
    const x0 = Math.floor(bb.minX)
    const x1 = Math.ceil(bb.maxX)
    const z0 = Math.floor(bb.minZ)
    const z1 = Math.ceil(bb.maxZ)
    const y0 = Math.floor(bb.maxY)
    const y1 = Math.ceil(bb.maxY)
    for (let y = y0; y < y1; y++) {
      let height = 0
      for (let x = x0; x < x1; x++) {
        for (let z = z0; z < z1; z++) {
          const water = waterIn(blockAt(x, y, z))
          if (water) height = Math.max(height, waterHeight(x, y, z, water))
        }
      }
      if (height < 1) return y + height
    }
    return y1 + 1
  }

  function blockBoxes (query) {
    const boxes = []
    for (let y = Math.floor(query.minY) - 1; y <= Math.floor(query.maxY); y++) {
      for (let z = Math.floor(query.minZ); z <= Math.floor(query.maxZ); z++) {
        for (let x = Math.floor(query.minX); x <= Math.floor(query.maxX); x++) {
          const block = blockAt(x, y, z)
          if (!block) continue
          for (const s of block.shapes) boxes.push(new AABB(...s).offset(x, y, z))
        }
      }
    }
    return boxes
  }

  // Entity.move: collide with blocks on Y, then on the larger horizontal axis first; stop on the blocked axes.
  function move (pos, vel) {
    const bb = boatBB(pos)
    const boxes = blockBoxes(bb.clone().extend(vel.x, vel.y, vel.z))
    let dy = vel.y
    for (const b of boxes) dy = b.computeOffsetY(bb, dy)
    bb.offset(0, dy, 0)
    let dx = vel.x
    let dz = vel.z
    const moveX = () => { for (const b of boxes) dx = b.computeOffsetX(bb, dx); bb.offset(dx, 0, 0) }
    const moveZ = () => { for (const b of boxes) dz = b.computeOffsetZ(bb, dz); bb.offset(0, 0, dz) }
    if (Math.abs(vel.x) < Math.abs(vel.z)) { moveZ(); moveX() } else { moveX(); moveZ() }
    const onGround = vel.y < 0 && dy !== vel.y
    vel.set(dx !== vel.x ? 0 : vel.x, dy !== vel.y ? 0 : vel.y, dz !== vel.z ? 0 : vel.z)
    pos.set(bb.minX + HALF_WIDTH, bb.minY, bb.minZ + HALF_WIDTH)
    return onGround
  }

  // Boat.floatBoat: friction, gravity and buoyancy for the current status.
  function floatBoat (pos, state, oldStatus) {
    const vel = state.velocity
    if (oldStatus === 'in_air' && state.status !== 'in_air' && state.status !== 'on_land') {
      // Fell into water: snap onto the surface.
      const bb = boatBB(pos)
      state.waterLevel = bb.maxY
      const surfaceY = waterLevelAbove(bb) - HEIGHT + 0.101
      const lifted = bb.clone().offset(0, surfaceY - pos.y, 0)
      if (!blockBoxes(lifted).some(b => b.intersects(lifted))) {
        pos.y = surfaceY
        vel.y = 0
      }
      state.status = 'in_water'
      return
    }
    let gravity = -GRAVITY
    let buoyancy = 0
    let invFriction = 0.05
    if (state.status === 'in_water') {
      buoyancy = (state.waterLevel - pos.y) / HEIGHT
      invFriction = 0.9
    } else if (state.status === 'under_flowing_water') {
      gravity = -7.0e-4
      invFriction = 0.9
    } else if (state.status === 'under_water') {
      buoyancy = 0.01
      invFriction = 0.45
    } else if (state.status === 'in_air') {
      invFriction = 0.9
    } else if (state.status === 'on_land') {
      state.landFriction /= 2 // a player is the controlling passenger
      invFriction = state.landFriction
    }
    vel.set(vel.x * invFriction, vel.y + gravity, vel.z * invFriction)
    state.deltaRotation *= invFriction
    if (buoyancy > 0) vel.y = (vel.y + buoyancy * (GRAVITY / 0.65)) * 0.75
  }

  // Boat.controlBoat: left/right turn, forward/back push along the heading.
  function controlBoat (state, input) {
    let push = 0
    if (input.left) state.deltaRotation -= 1
    if (input.right) state.deltaRotation += 1
    if (input.right !== input.left && !input.forward && !input.back) push += 0.005
    state.yaw += state.deltaRotation
    if (input.forward) push += 0.04
    if (input.back) push -= 0.005
    state.velocity.x += Math.sin(-state.yaw * DEG) * push
    state.velocity.z += Math.cos(state.yaw * DEG) * push
  }

  // One client tick of a boat driven with `input` ({ forward, back, left, right }). Moves `pos` in place
  // and returns whether the boat ended on the ground.
  function tick (pos, state, input) {
    const oldStatus = state.status
    state.status = getStatus(boatBB(pos), state)
    floatBoat(pos, state, oldStatus)
    controlBoat(state, input)
    return move(pos, state.velocity)
  }

  return { tick }
}

module.exports = { isBoat, createState, inject }
