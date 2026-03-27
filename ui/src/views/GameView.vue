<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const gameId = route.params.id as string
</script>

<template>
  <div class="game-container nes-container is-rounded">
    <button @click="router.back()" class="nes-btn is-error">&lt; BACK</button>
    <div class="game-header">
      <h2 class="nes-text is-error">{{ t(`message.games.${gameId}.title`) }}</h2>
      <p style="margin-top: 10px;">{{ t(`message.games.${gameId}.desc`) }}</p>
    </div>
    
    <div class="game-screen nes-container is-dark">
      <!-- Future game iframe or canvas would go here. For now a placeholder. -->
      <div class="screen-placeholder">
        <i class="nes-icon is-large star"></i>
        <p class="blink-text">PRESS START</p>
        <p>Game "{{ gameId }}" will be embedded here.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game-container {
  padding: 2rem !important;
  background-color: #fff !important;
  border-width: 4px;
}
.game-header {
  text-align: center;
  margin: 2rem 0;
}
.game-screen {
  aspect-ratio: 16/9;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  display: flex !important;
  align-items: center;
  justify-content: center;
  background-color: #000 !important;
  color: #fff;
  text-align: center;
  border-width: 4px;
}
.screen-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
}
.blink-text {
  animation: blinker 1s linear infinite;
  color: #FFD700;
  font-size: 1.5rem;
}
@keyframes blinker {
  50% { opacity: 0; }
}
</style>
