import type { FighterCommands, PlayerSlot } from './types'
import { emptyCommands } from './types'

/** CPU 感知的世界切片（引擎每帧喂入，CPU 不直接持有引擎引用） */
export interface CpuWorldView {
  self: {
    x: number
    hp: number
    energy: number
    airborne: boolean
    beamActive: boolean
  }
  foe: {
    x: number
    hp: number
    airborne: boolean
    guarding: boolean
    beamActive: boolean
    discIncoming: boolean
  }
  distance: number
}

type Intent = 'approach' | 'retreat' | 'hold' | 'attack-chain'

/**
 * 单人模式的 CPU 对手：
 * 反应式状态机 + 随机化决策节奏（意图 0.3~0.8 秒重估），行为全部通过
 * 与键盘/体感完全一致的 FighterCommands 通道下发，规则上不吃任何特殊增益
 */
export class DuelCpu {
  private readonly slot: PlayerSlot
  private readonly out: FighterCommands = emptyCommands()
  private intent: Intent = 'approach'
  private intentTimer = 0
  private nextDecision = 0
  private comboLeft = 0
  private nextAttackAt = 0
  private guardUntil = 0
  private jumpCd = 0

  constructor(slot: PlayerSlot) {
    this.slot = slot
  }

  public reset() {
    this.out.move = 0
    this.out.guard = false
    this.intent = 'approach'
    this.intentTimer = 0
    this.nextDecision = 0
    this.comboLeft = 0
    this.nextAttackAt = 0
    this.guardUntil = 0
    this.jumpCd = 0
  }

  /** 每帧返回当前指令（对象复用，引擎只读取，不持有） */
  public tick(dt: number, now: number, world: CpuWorldView): FighterCommands {
    this.out.move = 0
    this.out.guard = false
    this.out.punch = null
    this.out.kick = null
    this.out.discTrigger = false
    this.out.beamTrigger = false
    this.out.manualJumpUntil = 0

    if (this.jumpCd > 0) this.jumpCd -= dt
    this.intentTimer -= dt
    this.nextDecision -= dt

    const foeSign = Math.sign(world.foe.x - world.self.x) || 1

    // ---- 防御反应（最高优先级）：对手光线在轰 / 光轮在飞 ----
    if (world.foe.beamActive || world.foe.discIncoming) {
      if (this.guardUntil < now) {
        const roll = Math.random()
        if (roll < 0.5) {
          this.guardUntil = now + 700
        } else if (roll < 0.78 && this.jumpCd <= 0) {
          this.out.manualJumpUntil = now + 420
          this.jumpCd = 1.1
        } else {
          this.intent = 'retreat'
          this.intentTimer = 0.5
        }
      }
    }

    if (this.guardUntil > now) {
      this.out.guard = true
      // 防御中缓慢贴近，压迫感
      this.out.move = 0.35 * foeSign
      return this.out
    }

    // ---- 周期性意图重估 ----
    if (this.nextDecision <= 0) {
      this.nextDecision = 0.3 + Math.random() * 0.5
      const dist = world.distance
      if (dist > 14) {
        const roll = Math.random()
        if (roll < 0.72) this.intent = 'approach'
        else if (roll < 0.87 && world.self.energy >= 25) this.intent = 'hold' // 拉开丢光轮
        else this.intent = 'approach'
        if (this.intent === 'hold' && world.self.energy >= 25 && Math.random() < 0.8) {
          this.out.discTrigger = true
        }
      } else if (dist > 8.5) {
        const roll = Math.random()
        if (roll < 0.6) this.intent = 'approach'
        else if (roll < 0.8 && world.self.energy >= 60) this.intent = 'hold'
        else this.intent = 'approach'
        if (this.intent === 'hold' && world.self.energy >= 60) {
          this.out.beamTrigger = world.self.energy >= 60
        }
        if (Math.random() < 0.22 && this.jumpCd <= 0) {
          this.out.manualJumpUntil = now + 420
          this.jumpCd = 1.4
        }
      } else {
        const roll = Math.random()
        if (roll < 0.62) {
          this.intent = 'attack-chain'
          this.comboLeft = 1 + Math.floor(Math.random() * 3)
          this.nextAttackAt = 0
        } else if (roll < 0.78) {
          this.intent = 'retreat'
          this.intentTimer = 0.4 + Math.random() * 0.4
        } else {
          this.intent = 'attack-chain'
          this.comboLeft = 1
          this.nextAttackAt = 0
        }
      }
    }

    // ---- 意图执行 ----
    switch (this.intent) {
      case 'approach':
        this.out.move = foeSign * (0.75 + Math.random() * 0.25)
        if (world.distance < 7.5) {
          this.intent = 'attack-chain'
          this.comboLeft = 1 + Math.floor(Math.random() * 2)
          this.nextAttackAt = 0
        }
        break
      case 'retreat':
        if (this.intentTimer <= 0) this.nextDecision = 0
        this.out.move = -foeSign * 0.8
        break
      case 'hold':
        this.out.move = -foeSign * 0.25
        break
      case 'attack-chain':
        if (world.distance > 11) {
          this.intent = 'approach'
          break
        }
        this.nextAttackAt -= dt
        if (this.nextAttackAt <= 0 && this.comboLeft > 0) {
          this.comboLeft -= 1
          this.nextAttackAt = 0.26 + Math.random() * 0.22
          const roll = Math.random()
          if (roll < 0.68) {
            this.out.punch = Math.random() < 0.5 ? 'left' : 'right'
          } else if (roll < 0.9) {
            this.out.kick = Math.random() < 0.5 ? 'left' : 'right'
          } else if (world.self.energy >= 25) {
            this.out.discTrigger = true
          } else {
            this.out.punch = 'right'
          }
          if (Math.random() < 0.14) {
            this.out.guard = true
          }
        }
        if (this.comboLeft <= 0 && this.nextAttackAt <= 0) {
          this.intent = Math.random() < 0.45 ? 'retreat' : 'approach'
          this.intentTimer = 0.35
        }
        break
    }

    // 残血保守：血量落后且能量满时果断开大
    if (
      world.self.hp < world.foe.hp * 0.55 &&
      world.self.energy >= 100 &&
      !world.self.beamActive &&
      Math.random() < 0.02
    ) {
      this.out.beamTrigger = true
    }

    return this.out
  }
}
