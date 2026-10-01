<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()

type System = 'GB' | 'GBC' | 'GBA' | 'NES'

interface RetroGame {
  slug: string
  title: string
  author: string
  system: System
  core: string
  rom: string
}

// 全部为可自由分发的 homebrew，出处与许可见 public/roms/CREDITS.md
const games: RetroGame[] = [
  { slug: 'tobu', title: 'Tobu Tobu Girl', author: 'Simon Larsen', system: 'GB', core: 'gb', rom: 'tobu.gb' },
  { slug: '2048', title: '2048', author: 'Sanqui', system: 'GB', core: 'gb', rom: '2048.gb' },
  { slug: 'ucity', title: 'µCity', author: 'Antonio Niño Díaz', system: 'GBC', core: 'gb', rom: 'ucity.gbc' },
  { slug: 'anguna', title: 'Anguna', author: 'Nathan Tolbert', system: 'GBA', core: 'gba', rom: 'anguna.gba' },
  { slug: 'nova', title: 'Nova the Squirrel', author: 'NovaSquirrel', system: 'NES', core: 'nes', rom: 'nova-the-squirrel.nes' },
  { slug: 'stb', title: 'Super Tilt Bro', author: 'Sylvain Gadrat', system: 'NES', core: 'nes', rom: 'super-tilt-bro.nes' },
  { slug: 'driar', title: 'Driar', author: 'Adolfsson & Eriksson', system: 'NES', core: 'nes', rom: 'driar.nes' },
]

const current = ref<RetroGame | null>(null)

function insert(g: RetroGame | null) {
  current.value = g
}

function goBack() {
  router.back()
}

const playerSrc = computed(() => {
  const g = current.value
  if (!g) return ''
  const q = `core=${g.core}&rom=/roms/${g.rom}&title=${encodeURIComponent(g.title)}`
  return `/retro-player.html?${q}`
})
</script>

<template>
  <div class="retro-page">
    <div class="console">
      <!-- 机身顶栏：返回 / 品牌 / 喇叭格栅 -->
      <div class="console-top">
        <button class="mini-btn" @click="goBack">&lt; {{ t('message.retroView.back') }}</button>
        <div class="console-brand">FUN4GULU<sup>™</sup></div>
        <div class="speaker"><i></i><i></i><i></i><i></i></div>
      </div>

      <!-- 卡带架 -->
      <div v-if="!current" class="shelf">
        <div class="shelf-head">
          <h1>{{ t('message.retroView.title') }}</h1>
          <p>{{ t('message.retroView.hint') }}</p>
        </div>
        <div class="cart-grid">
          <button
            v-for="g in games"
            :key="g.slug"
            class="cart"
            :class="'sys-' + g.system.toLowerCase()"
            @click="insert(g)"
          >
            <span class="cart-grip"></span>
            <span class="cart-label">
              <span class="cart-system">{{ g.system }}</span>
              <span class="cart-title">{{ g.title }}</span>
              <span class="cart-author">{{ g.author }}</span>
            </span>
          </button>
        </div>
        <div class="shelf-foot">{{ t('message.retroView.license') }}</div>
      </div>

      <!-- 播放器 -->
      <div v-else class="player">
        <div class="player-bar">
          <span class="player-title">{{ current.title }} · {{ current.system }}</span>
          <button class="mini-btn" @click="insert(null)">{{ t('message.retroView.eject') }}</button>
        </div>
        <div class="screen-shell">
          <iframe
            :key="current.slug"
            class="player-frame"
            :src="playerSrc"
            allow="autoplay; fullscreen; gamepad"
            allowfullscreen
          ></iframe>
        </div>
        <div class="screen-caption">EMULATORJS · {{ current.system }} CORE</div>
      </div>

      <div class="console-bottom">MODEL GULU-15 · RETRO CARTRIDGE SYSTEM</div>
    </div>
  </div>
</template>

<style scoped>
.retro-page {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  padding: 96px 16px 28px;
  display: flex;
  justify-content: center;
  background: #EBEBEB;
}

/* 黄色掌机机身（与 Tetris 页一致） */
.console {
  width: min(432px, 100%);
  background: #FFC53D;
  border: 5px solid #000;
  border-radius: 20px 20px 44px 20px;
  box-shadow: 10px 10px 0 rgba(0, 0, 0, 0.9);
  padding: 14px 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
}

.console-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mini-btn {
  background: #000;
  color: #FFC53D;
  border: none;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.35);
}

.mini-btn:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.35);
}

.console-brand {
  font-size: 14px;
  font-weight: 950;
  letter-spacing: 1px;
  color: #7a4c00;
}

.speaker {
  display: flex;
  gap: 5px;
}

.speaker i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #b98a00;
  box-shadow: inset 1px 1px 2px rgba(0, 0, 0, 0.45);
}

/* 卡带架 */
.shelf {
  background: #1b1b26;
  border: 4px solid #000;
  border-radius: 10px;
  padding: 14px;
  box-shadow: inset 0 0 0 3px #33334a;
}

.shelf-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 950;
  color: #fff;
  letter-spacing: 1px;
}

.shelf-head p {
  margin: 4px 0 12px;
  font-size: 11px;
  font-weight: 700;
  color: #8a8ab0;
}

.cart-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

/* 卡带：顶部防滑纹 + 标签区 */
.cart {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: #23232e;
  border: 3px solid #000;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.6);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  -webkit-tap-highlight-color: transparent;
}

.cart:active {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.6);
}

.cart-grip {
  height: 12px;
  background: repeating-linear-gradient(
    90deg,
    #1a1a24 0 6px,
    #2c2c3a 6px 12px
  );
  border-bottom: 2px solid #000;
}

.cart-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 9px 10px;
  border-left: 4px solid var(--sys, #4FB033);
  min-height: 64px;
}

.sys-gb  { --sys: #4FB033; }
.sys-gbc { --sys: #B45CFF; }
.sys-gba { --sys: #4A90E2; }
.sys-nes { --sys: #E63946; }

.cart-system {
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--sys);
}

.cart-title {
  font-size: 13px;
  font-weight: 900;
  color: #fff;
  line-height: 1.25;
}

.cart-author {
  font-size: 9px;
  font-weight: 700;
  color: #8a8ab0;
}

.shelf-foot {
  margin-top: 12px;
  text-align: center;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #8a8ab0;
}

/* 播放器 */
.player {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.player-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.player-title {
  font-size: 14px;
  font-weight: 950;
  color: #7a4c00;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.screen-shell {
  background: #1b1b26;
  border: 4px solid #000;
  border-radius: 10px;
  padding: 8px;
  box-shadow: inset 0 0 0 3px #33334a;
}

.player-frame {
  display: block;
  width: 100%;
  height: min(66vh, 560px);
  border: 0;
  background: #0d0d1a;
}

.screen-caption {
  text-align: center;
  color: #7a4c00;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 2px;
}

.console-bottom {
  text-align: center;
  color: #7a4c00;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 2px;
}

/* 移动端适配 */
@media (max-width: 480px) {
  .retro-page {
    padding: 92px 10px 16px;
  }

  .console {
    padding: 12px 12px 18px;
    gap: 12px;
  }

  .cart-grid {
    gap: 10px;
  }

  .player-frame {
    height: min(62vh, 520px);
  }
}
</style>
