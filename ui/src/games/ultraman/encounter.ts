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
  | 'dying'
export type EncounterEvent = 'land' | 'collapse' | 'warn' | 'strike' | 'roar'
export type Impact = 'light' | 'heavy' | 'beam'
export const WINDUP_TIME = 1.35

/** 一个时钟驱动出招、碰撞、动画和提示。每个攻击的伤害帧只经过一次。 */
export class KaijuEncounter {
  state: MonsterState = 'idle'
  time = 0
  attack: MonsterAttackKind = 'fireball'
  targetX = 0
  enraged = false
  private cooldown = 2.4
  private sequence = 0
  private lightHits = 0

  enter(state: MonsterState) {
    this.state = state
    this.time = 0
  }

  reset() {
    this.cooldown = 2.4
    this.sequence = 0
    this.lightHits = 0
    this.enraged = false
    this.targetX = 0
    this.enter('entering')
  }

  receiveHit(base: number, kind: Impact, armored: boolean) {
    const state = this.state
    if (state === 'guarding') {
      if (kind === 'light') return Math.round(base * 0.35)
      this.enter('staggered')
      return base
    }
    if (state === 'staggered' || state === 'recovering') return Math.round(base * 1.5)
    if (state === 'idle' || state === 'hit') {
      this.lightHits = kind === 'light' ? this.lightHits + 1 : 0
      if (armored && this.lightHits === 2) {
        this.lightHits = 0
        this.enter('guarding')
      } else this.enter('hit')
    }
    return base
  }

  advance(
    dt: number,
    fighting: boolean,
    hpRatio: number,
    x: number,
    spec: MonsterSpec,
  ): EncounterEvent | undefined {
    const previous = this.time
    this.time += dt
    if (this.state === 'entering' && this.time >= 1.15) {
      this.enter('idle')
      return 'land'
    }
    if (this.state === 'dying' && previous < 1.05 && this.time >= 1.05) return 'collapse'
    if (!fighting) return
    switch (this.state) {
      case 'idle':
      case 'hit':
        if (!this.enraged && hpRatio <= 0.5) {
          this.enraged = true
          this.enter('roaring')
          return 'roar'
        }
        this.cooldown -= dt
        if (this.cooldown <= 0) {
          this.attack = spec.attacks[this.sequence++ % spec.attacks.length]!
          this.targetX = x
          this.lightHits = 0
          this.enter('windup')
          return 'warn'
        }
        if (this.state === 'hit' && this.time >= 0.38) this.enter('idle')
        break
      case 'windup':
        if (this.time >= WINDUP_TIME) {
          this.enter('attack')
          if (this.attack !== 'melee') return 'strike'
        }
        break
      case 'attack':
        if (this.attack === 'melee' && previous < 0.28 && this.time >= 0.28) return 'strike'
        if (this.time >= 0.65) this.enter('recovering')
        break
      case 'roaring':
      case 'guarding':
      case 'staggered':
      case 'recovering': {
        const duration = { roaring: 1.1, guarding: 1.4, staggered: 1.55, recovering: 0.85 }[
          this.state
        ]
        if (this.time >= duration) {
          this.cooldown = spec.attackInterval * (this.enraged ? 0.6 : 0.82)
          this.enter('idle')
        }
        break
      }
    }
  }
}
