<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { locale } = useI18n()
const isLangOpen = ref(false)

const languages = [
  { code: 'zh', name: 'ZH_CN' },
  { code: 'en', name: 'EN_US' },
  { code: 'jp', name: 'JA_JP' }
]

function changeLocale(code: string) {
  locale.value = code
  isLangOpen.value = false
}

const toggleLang = () => {
  isLangOpen.value = !isLangOpen.value
}

const closeLang = () => {
  isLangOpen.value = false
}

// Close on outside click
onMounted(() => {
  window.addEventListener('click', closeLang)
})
onUnmounted(() => {
  window.removeEventListener('click', closeLang)
})
</script>

<template>
  <div class="system-layout custom-cursor">
    <!-- Functional NES Grid Overlay -->
    <div class="grid-overlay"></div>

    <header class="mario-header">
      <div class="header-inner">
        <router-link to="/" class="brand-logo">
          <div class="logo-box-container">
            <div class="logo-box">G</div>
            <div class="logo-scanline"></div>
          </div>
          <div class="logo-text-group">
            <span class="logo-main">FUN4GULU</span>
            <span class="logo-sub">SYSTEM_V2.0.4</span>
          </div>
        </router-link>
        
        <nav class="meta-nav">
          <div class="system-status-group">
            <div class="status-item core-temp">
              <span class="label">CORE:</span>
              <span class="value">32°C</span>
            </div>
            <div class="status-item battery">
              <div class="battery-icon">
                <div class="battery-level"></div>
              </div>
              <span class="value">100%</span>
            </div>
            <div class="status-item clock">
              <span class="value">23:51</span>
            </div>
          </div>

          <div class="lang-selector-custom" @click.stop>
             <div class="lang-label">LNG:</div>
             <div class="custom-dropdown" :class="{ 'is-open': isLangOpen }">
                <button class="dropdown-trigger" @click="toggleLang">
                  <span class="current-val">{{ languages.find(l => l.code === locale)?.name }}</span>
                  <span class="chevron"></span>
                </button>
                <div class="dropdown-menu">
                   <div 
                     v-for="lang in languages" 
                     :key="lang.code"
                     class="dropdown-item"
                     :class="{ 'is-active': locale === lang.code }"
                     @click="changeLocale(lang.code)"
                   >
                     {{ lang.name }}
                   </div>
                </div>
             </div>
          </div>
        </nav>
      </div>
    </header>

    <main class="system-container">
      <router-view />
    </main>
  </div>
</template>

<style>
/* Pure CSS Mario Layout */
.system-layout {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.mario-header {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 80px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
  border-bottom: 2px solid #000;
  z-index: 1000;
  display: flex;
  align-items: center;
}

.header-inner {
  width: 100%;
  max-width: 1600px;
  margin: 0 auto;
  padding: 0 60px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.brand-logo {
  display: flex;
  align-items: center;
  text-decoration: none;
  color: #000;
}

.logo-box-container {
  position: relative;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border: 4px solid #000;
  box-shadow: 4px 4px 0 #000;
}

.logo-box {
  background: var(--mario-red);
  color: #FFF;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  font-size: 26px;
}

.logo-scanline {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 4px;
  background: rgba(255,255,255,0.3);
  animation: scanline 2s linear infinite;
}

@keyframes scanline {
  from { transform: translateY(-10px); }
  to { transform: translateY(50px); }
}

.logo-text-group {
  display: flex;
  flex-direction: column;
  margin-left: 16px;
}

.logo-main {
  font-weight: 950;
  font-size: 28px;
  line-height: 1;
  letter-spacing: -1.5px;
  color: #000;
}

.logo-sub {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.meta-nav {
  display: flex;
  align-items: center;
  gap: 40px;
}

.system-status-group {
  display: flex;
  align-items: center;
  gap: 24px;
  font-size: 11px;
  font-weight: 900;
  color: #000;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-item .label {
  color: var(--text-secondary);
}

.battery-icon {
  width: 22px;
  height: 12px;
  border: 2px solid #000;
  padding: 1px;
  position: relative;
}

.battery-icon::after {
  content: '';
  position: absolute;
  right: -4px;
  top: 2px;
  width: 2px;
  height: 4px;
  background: #000;
}

.battery-level {
  width: 100%;
  height: 100%;
  background: var(--mario-yoshi-green);
}

.lang-selector-custom {
  display: flex;
  align-items: center;
  gap: 12px;
  border-left: 2px solid #EEE;
  padding-left: 32px;
}

.custom-dropdown {
  position: relative;
  min-width: 100px;
}

.dropdown-trigger {
  background: #000;
  color: #FFF;
  border: none;
  padding: 6px 14px;
  font-weight: 950;
  font-size: 11px;
  letter-spacing: 0.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.dropdown-trigger .chevron {
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 4px solid #FFF;
  transition: transform 0.2s;
}

.is-open .dropdown-trigger .chevron {
  transform: rotate(180deg);
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 100%;
  background: #FFF;
  border: 3px solid #000;
  box-shadow: 8px 8px 0 rgba(0,0,0,0.1);
  display: none;
  z-index: 1001;
}

.is-open .dropdown-menu {
  display: block;
  animation: dropdown-pop 0.2s steps(4);
}

@keyframes dropdown-pop {
  from { transform: translateY(-5px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.dropdown-item {
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 900;
  cursor: pointer;
  color: #555;
  transition: all 0.1s;
}

.dropdown-item:hover {
  background: #F5F5F5;
  color: #000;
  padding-left: 18px;
}

.dropdown-item.is-active {
  background: var(--mario-red);
  color: #FFF;
}

.dropdown-item.is-active::before {
  content: '>';
  margin-right: 6px;
}

.system-container {
  width: 100%;
  margin-top: 80px; /* Offset fixed header */
}

/* Mobile Adaptive Layers */
@media (max-width: 1024px) {
  .header-inner { padding: 0 30px; }
  .system-status-group { gap: 15px; }
}

@media (max-width: 768px) {
  .mario-header { height: 64px; }
  .system-container { margin-top: 64px; }
  .header-inner { padding: 0 20px; }
  
  .logo-box-container { width: 34px; height: 34px; }
  .logo-box { font-size: 20px; }
  .logo-main { font-size: 20px; }
  .logo-sub { display: none; }
  
  .system-status-group { font-size: 9px; gap: 10px; }
  .status-item.core-temp { display: none; }
  .status-item.battery { gap: 4px; }
  .battery-icon { width: 18px; height: 10px; border-width: 1px; }
  
  .lang-selector-custom { padding-left: 15px; gap: 8px; }
  .lang-label { display: none; }
  .custom-dropdown { min-width: 80px; }
  .dropdown-trigger { padding: 4px 8px; font-size: 10px; }
}

@media (max-width: 480px) {
  .system-status-group { display: flex; gap: 8px; font-size: 8px; }
  .status-item.core-temp { display: none; }
  .status-item.battery { gap: 2px; }
  .battery-icon { width: 14px; height: 8px; }
  .battery-icon::after { right: -3px; top: 1px; width: 1px; height: 3px; }
  
  .header-inner { padding: 0 12px; justify-content: space-between; }
  .meta-nav { gap: 12px; }
  .lang-selector-custom { border-left: none; padding-left: 0; }
  .custom-dropdown { min-width: 70px; }
  .dropdown-trigger { padding: 4px 6px; font-size: 9px; }
}
</style>
