import type { MonsterAttackKind, MonsterSpec } from './types'

export type MonsterState =
  | 'entering'
  | 'idle'
  | 'hit'
  | 'guarding'
  | 'illusion'
  | 'absorbing'
  | 'windup'
  | 'attack'
  | 'recovering'
  | 'staggered'
  | 'roaring'
  | 'grapple'
  | 'thrown'
  | 'stunned'
  | 'finisher-hit'
  | 'dying'

export type EncounterEvent =
  | 'land'
  | 'collapse'
  | 'warn'
  | 'strike'
  | 'roar'
  | 'illusion-start'
  | 'absorb-start'
  | 'absorb-release'

export type Impact = 'light' | 'heavy' | 'beam' | 'disc'
export const WINDUP_TIME = 1.25

export interface HitResolution {
  damage: number
  absorbed: boolean
  guardBroken: boolean
  illusionBroken: boolean
  reflectedByShield: boolean
}

/**
 * 怪兽战斗状态机（支持 5 大怪兽专属机制与多高度招式）：
 * - 机械哥莫拉：重装冲锋（可触发角力）+ 连打护甲
 * - 巴尔坦星人：三体分身幻影（八分光轮 / 飞踢一键破除造成大硬直）
 * - 海帕杰顿：波状吸光护盾（吸收正面光线/光弹并反吐火球，需重击/飞踢破盾）
 * - 奇兽加恩Q：巨瞳蓄能吸收光弹，结束后反吐追踪紫弹（可被拳击弹回）
 * - 邪神加坦杰厄：高/低位黑雾触手横扫（深蹲/跳跃完美闪避）+ 暗黑光线对波
 */
export class KaijuEncounter {
  state: MonsterState = 'idle'
  time = 0
  attack: MonsterAttackKind = 'fireball'
  targetX = 0
  enraged = false
  /** 外部导演锁定时（角力/过肩摔/必杀终结期间），禁止常规 AI 自动发招 */
  directorLocked = false
  /** 巴尔坦分身真身索引 (-1 左, 0 中, 1 右) */
  illusionRealSlot: -1 | 0 | 1 = 0
  /** 加恩Q / 杰顿本轮吸收的伤害能量计数 */
  absorbedCharge = 0
  /** 当前机制破局提示词条键（供 HUD 显示战术提示） */
  specialHintKey: string | null = null

  private cooldown = 1.9
  private sequence = 0
  private lightHits = 0
  private specialCycle = 0

  enter(state: MonsterState) {
    this.state = state
    this.time = 0
    if (state !== 'illusion' && state !== 'guarding' && state !== 'absorbing') {
      this.specialHintKey = null
    }
  }

  reset() {
    this.cooldown = 1.9
    this.sequence = 0
    this.lightHits = 0
    this.specialCycle = 0
    this.absorbedCharge = 0
    this.illusionRealSlot = 0
    this.enraged = false
    this.directorLocked = false
    this.specialHintKey = null
    this.targetX = 0
    this.enter('entering')
  }

  public forceAttack(attack: MonsterAttackKind, targetX: number) {
    this.attack = attack
    this.targetX = targetX
    this.lightHits = 0
    this.enter('windup')
  }

  /** 解析玩家各类攻击对怪兽造成的伤害与机制互动 */
  receiveHit(base: number, kind: Impact, spec: MonsterSpec): HitResolution {
    const state = this.state
    if (state === 'grapple' || state === 'thrown' || state === 'dying') {
      return {
        damage: 0,
        absorbed: false,
        guardBroken: false,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    // 巴尔坦三体分身状态：光轮或重踢范围技一举击破全部分身造成大硬直
    if (state === 'illusion') {
      if (kind === 'disc' || kind === 'heavy' || kind === 'beam') {
        this.specialHintKey = null
        this.enter('staggered')
        return {
          damage: Math.round(base * 1.38),
          absorbed: false,
          guardBroken: true,
          illusionBroken: true,
          reflectedByShield: false,
        }
      }
      // 轻拳只打中幻影，减伤并提示使用八分光轮或飞踢
      this.specialHintKey = 'breakIllusion'
      return {
        damage: Math.round(base * 0.28),
        absorbed: false,
        guardBroken: false,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    // 加恩Q 巨瞳吸收状态：正面光线/光轮会被吸入蓄能，近身拳脚可强行打断
    if (state === 'absorbing') {
      if (kind === 'beam' || kind === 'disc') {
        this.absorbedCharge = Math.min(3, this.absorbedCharge + 1)
        this.specialHintKey = 'ganqAbsorb'
        return {
          damage: Math.round(base * 0.12),
          absorbed: true,
          guardBroken: false,
          illusionBroken: false,
          reflectedByShield: false,
        }
      }
      if (kind === 'heavy') {
        this.absorbedCharge = 0
        this.specialHintKey = null
        this.enter('staggered')
        return {
          damage: Math.round(base * 1.25),
          absorbed: false,
          guardBroken: true,
          illusionBroken: false,
          reflectedByShield: false,
        }
      }
      return {
        damage: Math.round(base * 0.85),
        absorbed: false,
        guardBroken: false,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    // 处决/眩晕窗口全额增伤
    if (state === 'stunned' || state === 'finisher-hit') {
      return {
        damage: Math.round(base * 1.48),
        absorbed: false,
        guardBroken: false,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    // 护盾防御态（海帕杰顿波状护盾专克光线，机械哥莫拉重甲格挡轻击）
    if (state === 'guarding') {
      if (spec.id === 'zetton' && (kind === 'beam' || kind === 'disc')) {
        this.absorbedCharge = Math.min(3, this.absorbedCharge + 1)
        this.specialHintKey = 'zettonShield'
        return {
          damage: Math.round(base * 0.1),
          absorbed: true,
          guardBroken: false,
          illusionBroken: false,
          reflectedByShield: true,
        }
      }
      if (kind === 'light') {
        this.specialHintKey =
          spec.id === 'zetton' ? 'zettonShield' : 'breakGuard'
        return {
          damage: Math.round(base * 0.32),
          absorbed: false,
          guardBroken: false,
          illusionBroken: false,
          reflectedByShield: false,
        }
      }
      this.specialHintKey = null
      this.enter('staggered')
      return {
        damage: Math.round(base * 1.26),
        absorbed: false,
        guardBroken: true,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    if (state === 'staggered' || state === 'recovering') {
      return {
        damage: Math.round(base * 1.32),
        absorbed: false,
        guardBroken: false,
        illusionBroken: false,
        reflectedByShield: false,
      }
    }

    // 常规态：带甲怪兽（机械哥莫拉/海帕杰顿）连续吃 4 轻击触发护盾反制
    if (state === 'idle' || state === 'hit') {
      const armored = spec.id === 'gomora-mecha' || spec.id === 'zetton'
      this.lightHits = kind === 'light' ? this.lightHits + 1 : 0
      if (armored && this.lightHits >= 4) {
        this.lightHits = 0
        this.specialHintKey =
          spec.id === 'zetton' ? 'zettonShield' : 'breakGuard'
        this.enter('guarding')
      } else {
        this.enter('hit')
      }
    }

    return {
      damage: base,
      absorbed: false,
      guardBroken: false,
      illusionBroken: false,
      reflectedByShield: false,
    }
  }

  advance(
    dt: number,
    fighting: boolean,
    hpRatio: number,
    x: number,
    spec: MonsterSpec,
    allowedAttacks?: MonsterAttackKind[],
    cooldownMul = 1,
    practiceMode = false,
  ): EncounterEvent | undefined {
    const previous = this.time
    this.time += dt

    if (this.state === 'entering' && this.time >= 1.15) {
      this.enter('idle')
      return 'land'
    }
    if (this.state === 'dying' && previous < 1.05 && this.time >= 1.05) return 'collapse'
    if (this.state === 'thrown' && previous < 0.72 && this.time >= 0.72) return 'land'
    if (!fighting || this.directorLocked) return

    // 靶场练习模式：怪兽主要作为可互动木桩，仅周期性出慢速演示招供玩家练习弹反/深蹲/跳跃
    if (practiceMode) {
      if (this.state === 'hit' && this.time >= 0.36) this.enter('idle')
      if (
        this.state === 'staggered' ||
        this.state === 'guarding' ||
        this.state === 'recovering' ||
        this.state === 'stunned'
      ) {
        if (this.time >= 1.35) this.enter('idle')
      }
      if (this.state === 'idle') {
        this.cooldown -= dt
        if (this.cooldown <= 0) {
          const demoPool: MonsterAttackKind[] = ['melee-high', 'melee-low', 'fireball']
          this.attack = demoPool[this.sequence++ % demoPool.length]!
          this.targetX = x
          this.enter('windup')
          this.cooldown = 6.2
          return 'warn'
        }
      } else if (this.state === 'windup' && this.time >= WINDUP_TIME * 1.2) {
        this.enter('attack')
        if (!this.isMeleeLike(this.attack)) return 'strike'
      } else if (this.state === 'attack') {
        if (this.isMeleeLike(this.attack) && previous < 0.3 && this.time >= 0.3) return 'strike'
        if (this.time >= 0.72) this.enter('recovering')
      }
      return
    }

    switch (this.state) {
      case 'idle':
      case 'hit':
        if (!this.enraged && hpRatio <= 0.54) {
          this.enraged = true
          this.enter('roaring')
          return 'roar'
        }
        this.cooldown -= dt
        if (this.cooldown <= 0) {
          this.specialCycle++
          // 怪兽专属机制周期穿插
          if (spec.id === 'ganq' && this.specialCycle % 3 === 0) {
            this.absorbedCharge = 1
            this.specialHintKey = 'ganqAbsorb'
            this.enter('absorbing')
            return 'absorb-start'
          }
          if (spec.id === 'zetton' && this.specialCycle % 3 === 0) {
            this.absorbedCharge = 0
            this.specialHintKey = 'zettonShield'
            this.enter('guarding')
            return undefined
          }

          const pool = allowedAttacks && allowedAttacks.length > 0 ? allowedAttacks : spec.attacks
          const chosen = pool[this.sequence++ % pool.length]!
          this.attack = chosen
          this.targetX = x
          this.lightHits = 0

          if (chosen === 'illusion') {
            const slots: (-1 | 0 | 1)[] = [-1, 0, 1]
            this.illusionRealSlot = slots[Math.floor(Math.random() * slots.length)]!
            this.specialHintKey = 'breakIllusion'
            this.enter('illusion')
            return 'illusion-start'
          }

          this.enter('windup')
          return 'warn'
        }
        if (this.state === 'hit' && this.time >= 0.38) this.enter('idle')
        break

      case 'illusion':
        // 分身持续 3.4 秒，若未被光轮/重击破除则直接偷袭发射冷光弹
        if (this.time >= 3.4) {
          this.specialHintKey = null
          this.attack = 'fireball'
          this.targetX = x
          this.enter('attack')
          return 'strike'
        }
        break

      case 'absorbing':
        // 加恩Q 吸能蓄力 2.3 秒，结束后吐回高能紫弹
        if (this.time >= 2.3) {
          this.specialHintKey = null
          this.attack = 'fireball'
          this.targetX = x
          this.enter('attack')
          return 'absorb-release'
        }
        break

      case 'windup': {
        const windupLimit = this.attack === 'charge' ? WINDUP_TIME * 1.15 : WINDUP_TIME
        if (this.time >= windupLimit) {
          this.enter('attack')
          if (!this.isMeleeLike(this.attack)) return 'strike'
        }
        break
      }

      case 'attack':
        if (this.isMeleeLike(this.attack) && previous < 0.28 && this.time >= 0.28) {
          return 'strike'
        }
        if (this.time >= 0.74) this.enter('recovering')
        break

      case 'roaring':
      case 'guarding':
      case 'staggered':
      case 'recovering':
      case 'stunned': {
        const durationMap: Record<string, number> = {
          roaring: 1.15,
          guarding: spec.id === 'zetton' ? 2.45 : 1.65,
          staggered: 1.95,
          recovering: 0.85,
          stunned: 3.4,
        }
        const duration = durationMap[this.state] ?? 1.0
        if (this.time >= duration) {
          this.specialHintKey = null
          this.cooldown = spec.attackInterval * (this.enraged ? 0.72 : 0.92) * cooldownMul
          this.enter('idle')
        }
        break
      }
    }
  }

  public isMeleeLike(attack: MonsterAttackKind): boolean {
    return (
      attack === 'melee' ||
      attack === 'melee-high' ||
      attack === 'melee-low' ||
      attack === 'charge'
    )
  }
}
