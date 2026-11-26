import type { MonsterAttackKind, MonsterSpec } from './types'

export type MonsterState =
  | 'entering'
  | 'idle'
  | 'hit'
  | 'guarding'
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

export type EncounterEvent = 'land' | 'collapse' | 'warn' | 'strike' | 'roar'
export type Impact = 'light' | 'heavy' | 'beam'
export const WINDUP_TIME = 1.45

/** 统一状态机时钟驱动怪兽攻防、破防硬直、角力被摔与残血处决状态 */
export class KaijuEncounter {
  state: MonsterState = 'idle'
  time = 0
  attack: MonsterAttackKind = 'fireball'
  targetX = 0
  enraged = false
  /** 外部导演锁定时（角力/过肩摔/必杀终结期间），禁止常规 AI 自动发招 */
  directorLocked = false
  private cooldown = 2.0
  private sequence = 0
  private lightHits = 0

  enter(state: MonsterState) {
    this.state = state
    this.time = 0
  }

  reset() {
    this.cooldown = 2.0
    this.sequence = 0
    this.lightHits = 0
    this.enraged = false
    this.directorLocked = false
    this.targetX = 0
    this.enter('entering')
  }

  public forceAttack(attack: MonsterAttackKind, targetX: number) {
    this.attack = attack
    this.targetX = targetX
    this.lightHits = 0
    this.enter('windup')
  }

  receiveHit(base: number, kind: Impact, armored: boolean) {
    const state = this.state
    if (state === 'grapple' || state === 'thrown' || state === 'dying') return 0
    if (state === 'stunned' || state === 'finisher-hit') {
      return Math.round(base * 1.45)
    }
    if (state === 'guarding') {
      if (kind === 'light') return Math.round(base * 0.35)
      this.enter('staggered')
      return Math.round(base * 1.18)
    }
    if (state === 'staggered' || state === 'recovering') return Math.round(base * 1.28)
    if (state === 'idle' || state === 'hit') {
      this.lightHits = kind === 'light' ? this.lightHits + 1 : 0
      if (armored && this.lightHits === 4) {
        this.lightHits = 0
        this.enter('guarding')
      } else {
        this.enter('hit')
      }
    }
    return base
  }

  advance(
    dt: number,
    fighting: boolean,
    hpRatio: number,
    x: number,
    spec: MonsterSpec,
    allowedAttacks?: MonsterAttackKind[],
    cooldownMul = 1,
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

    switch (this.state) {
      case 'idle':
      case 'hit':
        if (!this.enraged && hpRatio <= 0.52) {
          this.enraged = true
          this.enter('roaring')
          return 'roar'
        }
        this.cooldown -= dt
        if (this.cooldown <= 0) {
          const pool = allowedAttacks && allowedAttacks.length > 0 ? allowedAttacks : spec.attacks
          this.attack = pool[this.sequence++ % pool.length]!
          this.targetX = x
          this.lightHits = 0
          this.enter('windup')
          return 'warn'
        }
        if (this.state === 'hit' && this.time >= 0.42) this.enter('idle')
        break
      case 'windup':
        if (this.time >= WINDUP_TIME) {
          this.enter('attack')
          if (this.attack !== 'melee') return 'strike'
        }
        break
      case 'attack':
        if (this.attack === 'melee' && previous < 0.3 && this.time >= 0.3) return 'strike'
        if (this.time >= 0.72) this.enter('recovering')
        break
      case 'roaring':
      case 'guarding':
      case 'staggered':
      case 'recovering': {
        const duration = { roaring: 1.15, guarding: 1.55, staggered: 1.85, recovering: 0.92 }[
          this.state
        ]
        if (this.time >= duration) {
          this.cooldown = spec.attackInterval * (this.enraged ? 0.72 : 0.9) * cooldownMul
          this.enter('idle')
        }
        break
      }
    }
  }
}
