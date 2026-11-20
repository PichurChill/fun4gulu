import { createI18n } from 'vue-i18n'

const messages = {
  zh: {
    message: {
      title: 'Fun4Gulu 游戏合集',
      home: '回到首页',
      nav_games: '按【↓】查看游戏列表',
      games_list: '🎮 游戏列表',
      play: '开始',
      language: '选择语言:',
      welcome: '欢迎来到复古红白机游戏世界！',
      loading: '加载中...',
      coming_soon: '更多游戏，敬请期待...',
      games: {
        "jump-cat": {
          title: '跳跳猫',
          desc: '体感跳跃小游戏！站在摄像头前跳跃，小猫同步跳跃得分！'
        },
        "hurdle-cat": {
          title: '跨栏小猫',
          desc: '第一视角跨栏游戏！小猫持续前进，跳跃躲避栏杆！'
        },
        tetris: {
          title: '俄罗斯方块',
          desc: '经典掌机俄罗斯方块！移动、旋转、消行，冲击最高分！'
        },
        retro: {
          title: '复古游戏机',
          desc: '复古卡带合集！GB / GBC / GBA / NES 模拟器，7 款自制经典即点即玩！'
        },
        ultraman: {
          title: '迪迦奥特曼体感',
          desc: '第三人称 3D 奥特曼体感超激斗！挥拳、格挡、发射哉佩利敖光线击败五大经典怪兽！'
        },
        demo1: {
          title: '示例小游戏 1',
          desc: '一个简单的网页小游戏Demo。'
        },
        demo2: {
          title: '示例小游戏 2',
          desc: '探索未知的像素世界。'
        }
      },
      tetrisView: {
        title: '俄罗斯方块',
        description: '经典掌机俄罗斯方块！移动、旋转方块，消除整行得分！',
        startButton: '开始游戏',
        back: '返回',
        score: '得分',
        level: '等级',
        lines: '行数',
        next: '下一个',
        item: '道具',
        itemEmpty: '空',
        paused: '已暂停',
        clickToResume: '点击继续',
        gameOver: '游戏结束',
        finalScore: '最终得分',
        restartButton: '再来一局',
        instructions: '← → 移动 · ↓ 加速下落 · ↑ 旋转 · P 暂停（触屏用下方按键）'
      },
      retroView: {
        title: '复古卡带',
        hint: '点击卡带插入即玩（触屏自动显示虚拟手柄）',
        back: '返回',
        eject: '退出卡带',
        license: '全部为可自由分发的 homebrew（自制）游戏'
      },
      jumpCatView: {
        title: '跳跳猫',
        description: '站在摄像头前，跳跃得分！',
        startButton: '🎮 开始游戏',
        back: '返回',
        score: '分数',
        combo: '连击',
        debug: '调试',
        stop: '结束',
        calibrating: '请站在画面中间，校准中...'
      },
      hurdleCatView: {
        title: '跨栏小猫',
        description: '小猫一直在前进，跳跃躲避栏杆！',
        startButton: '🎮 开始游戏',
        back: '返回',
        score: '分数',
        combo: '连击',
        debug: '调试',
        stop: '结束',
        calibrating: '请站在画面中间，校准中...',
        controlMode: '控制模式',
        bodyMode: '身体',
        handMode: '手部',
        instructionsBody: '身体左右摆动切换车道，跳跃躲避栏杆',
        instructionsHand: '抬起左手/右手切换车道，双手上抬跳跃'
      },
      ultramanView: {
        title: '迪迦奥特曼 · 体感超激斗',
        subtitle: '化身光之巨人，在海港城市迎战五大宇宙怪兽！',
        cameraMode: '体感模式（摄像头）',
        keyboardMode: '键盘 / 触屏模式',
        selectStage: '选择挑战关卡',
        startButton: '变身出击！',
        loadingModel: '光之能量汇聚中...',
        back: '返回',
        stop: '退出',
        score: '得分',
        combo: '连击',
        wave: '第 {current}/{total} 波',
        energy: '光之能量',
        energyReady: '可发射哉佩利敖光线！',
        energyFull: '满能！摆出 L / 十字 释放终极光线！',
        heroHp: '迪迦生命',
        mute: '静音',
        unmute: '有声',
        recenter: '校准站位',
        skeleton: '骨骼',
        cameraError: '无法启动摄像头，请检查权限或切换到键盘模式：',
        switchToKeyboard: '改用键盘模式开战',
        moves: {
          punch: '左右挥拳',
          punchDesc: '出拳连击打怪兽',
          dodge: '左右侧身',
          dodgeDesc: '躲避怪兽火球',
          guard: '胸前 X 交叉',
          guardDesc: '奥特屏障格挡',
          disc: '举手下挥',
          discDesc: '八分光轮打断',
          beam: '摆 L / 十字',
          beamDesc: '哉佩利敖光线'
        },
        monsters: {
          baltan: '巴尔坦星人',
          ganq: '奇兽·加恩Q',
          zetton: '宇宙恐龙·杰顿',
          'gomora-mecha': '机械哥莫拉',
          gatanothor: '邪神·加坦杰厄'
        },
        hints: {
          hintStandCenter: '请站在摄像头中间，露出双臂',
          hintShowArms: '退后半步露出双臂即可释放必杀',
          hintReady: '挥拳出击！摆 L 或 十字 放光线',
          hintPunch: '重拳出击！',
          hintGuardPrep: '双臂交叉准备防御…',
          hintGuardActive: '奥特屏障已展开！',
          hintBeamCharge: '保持 L / 十字 凝聚哉佩利敖光线…',
          hintBeamFire: '哉佩利敖光线发射！',
          hintDiscCharge: '单手高举凝聚八分光轮…',
          hintDiscThrow: '光轮就绪，向下挥出！',
          hintDiscFire: '八分光轮！'
        },
        warnings: {
          warningFireball: '危险！怪兽发射火球 — 交叉防御或左右躲避！',
          warningMelee: '危险！怪兽突进重击 — 双臂交叉防御！',
          warningDarkBeam: '警告！暗黑光线来袭 — 快交叉防御！'
        },
        banners: {
          bannerWaveStart: '怪兽出现！战斗开始！',
          bannerBeam: '哉佩利敖光线！',
          bannerSuperBeam: '终极闪耀·哉佩利敖光线！',
          bannerDisc: '八分光轮！',
          bannerPerfectGuard: '完美防御！能量飙升！',
          bannerInterrupt: '成功打断怪兽蓄力！',
          bannerWaveClear: '怪兽击败！能量恢复！',
          bannerVictory: '地球和平已守护！光之胜利！',
          bannerDefeat: '计时器熄灭…再相信一次光！'
        },
        controls: {
          left: '左闪',
          right: '右闪',
          guard: '防御',
          punchL: '左拳',
          punchR: '右拳',
          disc: '光轮',
          beam: '光线',
          keyboardHint: 'A/D 闪避 · S 防御 · J/K 出拳 · U 光轮 · 空格 哉佩利敖光线'
        },
        result: {
          victoryTitle: '光之巨人 · 全关制霸！',
          defeatTitle: '再站起来，迪迦！',
          totalScore: '最终得分',
          defeated: '击败怪兽',
          maxCombo: '最高连击',
          perfectGuards: '完美防御',
          playAgain: '再战一次',
          backHome: '返回首页'
        }
      }
    }
  },
  en: {
    message: {
      title: 'Fun4Gulu Game Collection',
      home: 'Back Home',
      nav_games: 'Press [↓] to view games',
      games_list: '🎮 Game List',
      play: 'Start',
      language: 'Language:',
      welcome: 'Welcome to the retro 8-bit game world!',
      loading: 'Loading...',
      coming_soon: 'More games coming soon...',
      games: {
        "jump-cat": {
          title: 'Jump Cat',
          desc: 'A motion-sensing jumping game! Stand in front of the camera and jump!'
        },
        "hurdle-cat": {
          title: 'Hurdle Cat',
          desc: 'First-person hurdle game! The cat keeps moving forward, jump to avoid hurdles!'
        },
        tetris: {
          title: 'Tetris',
          desc: 'Classic handheld Tetris! Move, rotate and clear lines for the high score!'
        },
        retro: {
          title: 'Retro Console',
          desc: 'Retro cartridge collection! GB/GBC/GBA/NES emulator with 7 homebrew classics, tap to play!'
        },
        ultraman: {
          title: 'Ultraman Tiga Motion',
          desc: '3D third-person Ultraman motion battle! Punch, guard, and fire Zepellion Ray to defeat 5 iconic kaiju!'
        },
        demo1: {
          title: 'Demo Game 1',
          desc: 'A simple web game demo.'
        },
        demo2: {
          title: 'Demo Game 2',
          desc: 'Explore the unknown pixel world.'
        }
      },
      tetrisView: {
        title: 'Tetris',
        description: 'Classic handheld Tetris! Move and rotate blocks, clear full lines to score!',
        startButton: 'Start Game',
        back: 'BACK',
        score: 'SCORE',
        level: 'LEVEL',
        lines: 'LINES',
        next: 'NEXT',
        item: 'ITEM',
        itemEmpty: 'EMPTY',
        paused: 'PAUSED',
        clickToResume: 'Click to resume',
        gameOver: 'GAME OVER',
        finalScore: 'FINAL SCORE',
        restartButton: 'Play Again',
        instructions: '← → move · ↓ soft drop · ↑ rotate · P pause (or touch buttons below)'
      },
      retroView: {
        title: 'Retro Cartridges',
        hint: 'Tap a cartridge to insert and play (virtual gamepad on touch)',
        back: 'BACK',
        eject: 'EJECT',
        license: 'All games are freely distributable homebrew'
      },
      jumpCatView: {
        title: 'Jump Cat',
        description: 'Stand in front of the camera and jump to score!',
        startButton: '🎮 Start Game',
        back: 'BACK',
        score: 'SCORE',
        combo: 'COMBO',
        debug: 'DEBUG',
        stop: 'STOP',
        calibrating: 'Stand in center, calibrating...'
      },
      hurdleCatView: {
        title: 'Hurdle Cat',
        description: 'The cat keeps moving forward, jump to avoid hurdles!',
        startButton: '🎮 Start Game',
        back: 'BACK',
        score: 'SCORE',
        combo: 'COMBO',
        debug: 'DEBUG',
        stop: 'STOP',
        calibrating: 'Stand in center, calibrating...',
        controlMode: 'Control Mode',
        bodyMode: 'Body',
        handMode: 'Hand',
        instructionsBody: 'Lean body to switch lanes, jump to avoid hurdles',
        instructionsHand: 'Raise left/right hand to switch lane, raise both to jump'
      },
      ultramanView: {
        title: 'ULTRAMAN TIGA · MOTION BATTLE',
        subtitle: 'Become the Giant of Light and defend the harbor city against 5 iconic kaiju!',
        cameraMode: 'Motion Camera',
        keyboardMode: 'Keyboard / Touch',
        selectStage: 'Select Wave',
        startButton: 'TRANSFORM!',
        loadingModel: 'Gathering Light Energy...',
        back: 'BACK',
        stop: 'EXIT',
        score: 'SCORE',
        combo: 'COMBO',
        wave: 'WAVE {current}/{total}',
        energy: 'LIGHT ENERGY',
        energyReady: 'Zepellion Ray Ready!',
        energyFull: 'MAX! Form L / + to fire SUPER RAY!',
        heroHp: 'TIGA HP',
        mute: 'MUTE',
        unmute: 'SFX',
        recenter: 'RECENTER',
        skeleton: 'POSE',
        cameraError: 'Camera unavailable. Check permissions or switch to Keyboard mode: ',
        switchToKeyboard: 'Play with Keyboard',
        moves: {
          punch: 'Punch',
          punchDesc: 'Throw left/right punches',
          dodge: 'Lean L/R',
          dodgeDesc: 'Dodge kaiju fireballs',
          guard: 'Cross Arms X',
          guardDesc: 'Ultra Shield guard',
          disc: 'Raise & Chop',
          discDesc: 'Ultra Slash interrupt',
          beam: 'L / + Pose',
          beamDesc: 'Zepellion Ray!'
        },
        monsters: {
          baltan: 'Alien Baltan',
          ganq: 'Gan-Q',
          zetton: 'Zetton',
          'gomora-mecha': 'Mecha Gomora',
          gatanothor: 'Gatanothor'
        },
        hints: {
          hintStandCenter: 'Stand in front of the camera with arms visible',
          hintShowArms: 'Step back slightly so both arms are visible',
          hintReady: 'Punch! Or make L / + pose for Zepellion Ray',
          hintPunch: 'Ultra Punch!',
          hintGuardPrep: 'Crossing arms to guard...',
          hintGuardActive: 'Ultra Barrier Active!',
          hintBeamCharge: 'Hold L / + pose to charge beam...',
          hintBeamFire: 'ZEPELLION RAY!',
          hintDiscCharge: 'Raise hand high to form Ultra Slash...',
          hintDiscThrow: 'Slash ready! Swing down!',
          hintDiscFire: 'ULTRA SLASH!'
        },
        warnings: {
          warningFireball: 'DANGER! Fireball incoming — Cross Guard or Dodge!',
          warningMelee: 'DANGER! Kaiju lunge — Cross Arms to Guard!',
          warningDarkBeam: 'WARNING! Dark Beam — Cross Arms to Guard!'
        },
        banners: {
          bannerWaveStart: 'KAIJU ALERT! BATTLE START!',
          bannerBeam: 'ZEPELLION RAY!',
          bannerSuperBeam: 'GLITTER ZEPELLION RAY!',
          bannerDisc: 'ULTRA SLASH!',
          bannerPerfectGuard: 'PERFECT GUARD! +ENERGY!',
          bannerInterrupt: 'CHARGE INTERRUPTED!',
          bannerWaveClear: 'KAIJU DEFEATED!',
          bannerVictory: 'PEACE RESTORED! VICTORY!',
          bannerDefeat: 'COLOR TIMER OUT...'
        },
        controls: {
          left: 'LEFT',
          right: 'RIGHT',
          guard: 'GUARD',
          punchL: 'L-PUNCH',
          punchR: 'R-PUNCH',
          disc: 'SLASH',
          beam: 'RAY',
          keyboardHint: 'A/D Dodge · S Guard · J/K Punch · U Ultra Slash · Space Zepellion Ray'
        },
        result: {
          victoryTitle: 'GIANT OF LIGHT · VICTORY!',
          defeatTitle: 'RISE AGAIN, TIGA!',
          totalScore: 'FINAL SCORE',
          defeated: 'DEFEATED',
          maxCombo: 'MAX COMBO',
          perfectGuards: 'PERFECT GUARDS',
          playAgain: 'PLAY AGAIN',
          backHome: 'HOME'
        }
      }
    }
  },
  ja: {
    message: {
      title: 'Fun4Gulu ゲームコレクション',
      home: 'ホームへ戻る',
      nav_games: '【↓】を押してゲームリストを見る',
      games_list: '🎮 ゲームリスト',
      play: 'スタート',
      language: '言語選択:',
      welcome: 'レトロな8ビットゲームの世界へようこそ！',
      loading: 'ロード中...',
      coming_soon: 'もっと多くのゲームをお楽しみに...',
      games: {
        "jump-cat": {
          title: 'ジャンプ猫',
          desc: '体感ジャンプゲーム！カメラの前に立ってジャンプしよう！'
        },
        "hurdle-cat": {
          title: 'ハードル猫',
          desc: '一人称視点ハードルゲーム！猫が前に進み続け、ジャンプしてハードルを避けよう！'
        },
        tetris: {
          title: 'テトリス',
          desc: 'クラシックな携帯型テトリス！移動・回転・ライン消去でハイスコアを狙え！'
        },
        retro: {
          title: 'レトロゲーム機',
          desc: 'レトロカートリッジ集！GB/GBC/GBA/NES エミュレータで自作名作7本をすぐプレイ！'
        },
        ultraman: {
          title: 'ウルトラマンティガ体感',
          desc: '3D三人称体感バトル！パンチ・ガード・ゼペリオン光線で5大怪獣を倒せ！'
        },
        demo1: {
          title: 'デモゲーム 1',
          desc: '簡単なWebゲームのデモ。'
        },
        demo2: {
          title: 'デモゲーム 2',
          desc: '未知のピクセル世界を探索しよう。'
        }
      },
      tetrisView: {
        title: 'テトリス',
        description: 'クラシックな携帯型テトリス！ブロックを移動・回転してラインを消そう！',
        startButton: 'ゲームスタート',
        back: '戻る',
        score: 'スコア',
        level: 'レベル',
        lines: 'ライン',
        next: 'つぎ',
        item: 'アイテム',
        itemEmpty: 'なし',
        paused: '一時停止',
        clickToResume: 'クリックで再開',
        gameOver: 'ゲームオーバー',
        finalScore: '最終スコア',
        restartButton: 'もう一度',
        instructions: '← → 移動 · ↓ 高速落下 · ↑ 回転 · P 一時停止（画面下のボタンもOK）'
      },
      retroView: {
        title: 'レトロカートリッジ',
        hint: 'カートリッジをタップして挿入、すぐプレイ（タッチは仮想パッド）',
        back: '戻る',
        eject: 'イジェクト',
        license: 'すべて自由配布可能なホームブルー作品です'
      },
      jumpCatView: {
        title: 'ジャンプ猫',
        description: 'カメラの前に立ってジャンプして得点！',
        startButton: '🎮 ゲームスタート',
        back: '戻る',
        score: 'スコア',
        combo: 'コンボ',
        debug: 'デバッグ',
        stop: '終了',
        calibrating: '画面の中央に立ってください、校正中...'
      },
      hurdleCatView: {
        title: 'ハードル猫',
        description: '猫が前に進み続け、ジャンプしてハードルを避けよう！',
        startButton: '🎮 ゲームスタート',
        back: '戻る',
        score: 'スコア',
        combo: 'コンボ',
        debug: 'デバッグ',
        stop: '終了',
        calibrating: '画面の中央に立ってください、校正中...',
        controlMode: 'コントロールモード',
        bodyMode: '体',
        handMode: '手',
        instructionsBody: '体を左右に傾けてレーン変更、ジャンプしてハードルを回避',
        instructionsHand: '左右の手を上げてレーン切り替え、両手上げでジャンプ'
      },
      ultramanView: {
        title: 'ウルトラマンティガ・体感バトル',
        subtitle: '光の巨人となり、港街で5大怪獣に立ち向かえ！',
        cameraMode: '体感カメラモード',
        keyboardMode: 'キーボード / タッチ',
        selectStage: 'ステージ選択',
        startButton: '変身スタート！',
        loadingModel: '光のエネルギー集結中...',
        back: '戻る',
        stop: '終了',
        score: 'スコア',
        combo: 'コンボ',
        wave: 'WAVE {current}/{total}',
        energy: '光エネルギー',
        energyReady: 'ゼペリオン光線発射可能！',
        energyFull: 'MAX！L字/十字で超必殺光線！',
        heroHp: 'ティガ体力',
        mute: '消音',
        unmute: '音声',
        recenter: '位置調整',
        skeleton: '骨格',
        cameraError: 'カメラを起動できません。権限を確認するかキーボードに切り替えてください：',
        switchToKeyboard: 'キーボードでプレイ',
        moves: {
          punch: '左右パンチ',
          punchDesc: 'パンチ連撃で攻撃',
          dodge: '左右に避ける',
          dodgeDesc: '火球をステップ回避',
          guard: '胸前でX交差',
          guardDesc: 'ウルトラバリア防御',
          disc: '頭上から振り下ろす',
          discDesc: '八つ裂き光輪',
          beam: 'L字 / 十字',
          beamDesc: 'ゼペリオン光線'
        },
        monsters: {
          baltan: 'バルタン星人',
          ganq: '奇獣ガンQ',
          zetton: '宇宙恐竜ゼットン',
          'gomora-mecha': 'メカゴモラ',
          gatanothor: '邪神ガタノゾーア'
        },
        hints: {
          hintStandCenter: 'カメラの中央に立ち、両腕を見せてください',
          hintShowArms: '少し下がって両腕を映してください',
          hintReady: 'パンチで攻撃！L字/十字で光線発射！',
          hintPunch: 'ウルトラパンチ！',
          hintGuardPrep: '両腕交差でガード準備…',
          hintGuardActive: 'ウルトラバリア展開！',
          hintBeamCharge: 'L字/十字をキープして光線チャージ…',
          hintBeamFire: 'ゼペリオン光線発射！',
          hintDiscCharge: '片手を高く上げて光輪チャージ…',
          hintDiscThrow: '準備完了！振り下ろせ！',
          hintDiscFire: '八つ裂き光輪！'
        },
        warnings: {
          warningFireball: '危険！怪獣の火球！ガードか左右回避！',
          warningMelee: '危険！怪獣の突進！両腕交差でガード！',
          warningDarkBeam: '警告！闇の光線！両腕交差でガード！'
        },
        banners: {
          bannerWaveStart: '怪獣出現！バトル開始！',
          bannerBeam: 'ゼペリオン光線！',
          bannerSuperBeam: 'グリッター・ゼペリオン光線！',
          bannerDisc: '八つ裂き光輪！',
          bannerPerfectGuard: 'パーフェクトガード！',
          bannerInterrupt: 'チャージ阻止成功！',
          bannerWaveClear: '怪獣撃破！体力回復！',
          bannerVictory: '地球の平和を守り抜いた！',
          bannerDefeat: 'カラータイマーが消えた…'
        },
        controls: {
          left: '左回避',
          right: '右回避',
          guard: '防御',
          punchL: '左拳',
          punchR: '右拳',
          disc: '光輪',
          beam: '光線',
          keyboardHint: 'A/D 回避 · S 防御 · J/K パンチ · U 光輪 · Space ゼペリオン光線'
        },
        result: {
          victoryTitle: '光の巨人・全ステージ制覇！',
          defeatTitle: 'もう一度立ち上がれ、ティガ！',
          totalScore: '最終スコア',
          defeated: '撃破怪獣',
          maxCombo: '最大コンボ',
          perfectGuards: '完全防御',
          playAgain: 'もう一度遊ぶ',
          backHome: 'ホームへ'
        }
      }
    }
  },
  ko: {
    message: {
      title: 'Fun4Gulu 게임 컬렉션',
      home: '홈으로',
      nav_games: '[↓] 눌러 게임 목록 보기',
      games_list: '🎮 게임 목록',
      play: '시작',
      language: '언어:',
      welcome: '레트로 8비트 게임 세계에 오신 것을 환영합니다!',
      loading: '로딩 중...',
      coming_soon: '더 많은 게임이 곧 제공됩니다...',
      games: {
        "jump-cat": {
          title: '점프 고양이',
          desc: '체감 점프 게임! 카메라 앞에 서서 점프하세요!'
        },
        "hurdle-cat": {
          title: '허들 고양이',
          desc: '1인칭 허들 게임! 고양이가 계속 앞으로 나아가고, 점프하여 허들을 피하세요!'
        },
        tetris: {
          title: '테트리스',
          desc: '클래식 휴대용 테트리스! 이동, 회전, 라인 클리어로 최고 점수에 도전!'
        },
        retro: {
          title: '레트로 게임기',
          desc: '레트로 카트리지 컬렉션! GB/GBC/GBA/NES 에뮬레이터로 홈브류 명작 7종을 바로 플레이!'
        },
        ultraman: {
          title: '울트라맨 티가 체감',
          desc: '3D 3인칭 체감 배틀! 펀치, 가드, 제페리온 광선으로 5대 괴수를 물리치세요!'
        },
        demo1: {
          title: '데모 게임 1',
          desc: '간단한 웹 게임 데모.'
        },
        demo2: {
          title: '데모 게임 2',
          desc: '미지의 픽셀 세계를 탐험하세요.'
        }
      },
      tetrisView: {
        title: '테트리스',
        description: '클래식 휴대용 테트리스! 블록을 이동하고 회전하여 라인을 지우세요!',
        startButton: '게임 시작',
        back: '뒤로',
        score: '점수',
        level: '레벨',
        lines: '줄',
        next: '다음',
        item: '아이템',
        itemEmpty: '없음',
        paused: '일시정지',
        clickToResume: '클릭하여 계속',
        gameOver: '게임 오버',
        finalScore: '최종 점수',
        restartButton: '다시 하기',
        instructions: '← → 이동 · ↓ 빠른 낙하 · ↑ 회전 · P 일시정지 (하단 버튼 사용 가능)'
      },
      retroView: {
        title: '레트로 카트리지',
        hint: '카트리지를 눌러 끼우고 바로 즐기세요(터치는 가상 패드)',
        back: '돌아가기',
        eject: '카트리지 빼기',
        license: '모두 자유 배포 가능한 홈브류 게임입니다'
      },
      jumpCatView: {
        title: '점프 고양이',
        description: '카메라 앞에 서서 점프하여 점수를 획득하세요!',
        startButton: '🎮 게임 시작',
        back: '뒤로',
        score: '점수',
        combo: '콤보',
        debug: '디버그',
        stop: '종료',
        calibrating: '화면 중앙에 서 주세요, 보정 중...'
      },
      hurdleCatView: {
        title: '허들 고양이',
        description: '고양이가 계속 앞으로 나아가고, 점프하여 허들을 피하세요!',
        startButton: '🎮 게임 시작',
        back: '뒤로',
        score: '점수',
        combo: '콤보',
        debug: '디버그',
        stop: '종료',
        calibrating: '화면 중앙에 서 주세요, 보정 중...',
        controlMode: '컨트롤 모드',
        bodyMode: '몸',
        handMode: '손',
        instructionsBody: '몸을 좌우로 기울여 차선 변경, 점프하여 허들 회피',
        instructionsHand: '왼손/오른손을 들어 차선 변경, 양손을 들어 점프'
      },
      ultramanView: {
        title: '울트라맨 티가 · 체감 배틀',
        subtitle: '빛의 거인이 되어 항구 도시의 5대 괴수에 맞서 싸우세요!',
        cameraMode: '체감 카메라 모드',
        keyboardMode: '키보드 / 터치 모드',
        selectStage: '스테이지 선택',
        startButton: '변신 출격!',
        loadingModel: '빛의 에너지 충전 중...',
        back: '뒤로',
        stop: '종료',
        score: '점수',
        combo: '콤보',
        wave: 'WAVE {current}/{total}',
        energy: '빛 에너지',
        energyReady: '제페리온 광선 발사 가능!',
        energyFull: 'MAX! L / + 포즈로 궁극 광선!',
        heroHp: '티가 체력',
        mute: '음소거',
        unmute: '소리',
        recenter: '위치 보정',
        skeleton: '스켈레톤',
        cameraError: '카메라를 시작할 수 없습니다. 권한을 확인하거나 키보드 모드로 전환하세요: ',
        switchToKeyboard: '키보드로 플레이',
        moves: {
          punch: '좌우 펀치',
          punchDesc: '연속 펀치 공격',
          dodge: '좌우 회피',
          dodgeDesc: '화염구 피하기',
          guard: '가슴 X 교차',
          guardDesc: '울트라 배리어 방어',
          disc: '손 들어 내려치기',
          discDesc: '울트라 슬래시',
          beam: 'L / + 포즈',
          beamDesc: '제페리온 광선'
        },
        monsters: {
          baltan: '발탄 성인',
          ganq: '기수 간Q',
          zetton: '우주공룡 젯톤',
          'gomora-mecha': '메카 고모라',
          gatanothor: '사신 가타노조아'
        },
        hints: {
          hintStandCenter: '카메라 중앙에 서서 양팔이 보이게 하세요',
          hintShowArms: '조금 뒤로 물러서 양팔을 보여주세요',
          hintReady: '펀치 공격! L 또는 + 포즈로 광선 발사!',
          hintPunch: '울트라 펀치!',
          hintGuardPrep: '양팔을 교차해 방어 준비…',
          hintGuardActive: '울트라 배리어 발동!',
          hintBeamCharge: 'L / + 포즈를 유지해 광선 충전 중…',
          hintBeamFire: '제페리온 광선 발사!',
          hintDiscCharge: '한 손을 높이 들어 광륜 충전 중…',
          hintDiscThrow: '준비 완료! 아래로 휘두르세요!',
          hintDiscFire: '울트라 슬래시!'
        },
        warnings: {
          warningFireball: '위험! 화염구 접근 — 가드 또는 좌우 회피!',
          warningMelee: '위험! 괴수 돌진 — 양팔 교차 방어!',
          warningDarkBeam: '경고! 암흑 광선 — 양팔 교차 방어!'
        },
        banners: {
          bannerWaveStart: '괴수 출현! 전투 시작!',
          bannerBeam: '제페리온 광선!',
          bannerSuperBeam: '글리터 제페리온 광선!',
          bannerDisc: '울트라 슬래시!',
          bannerPerfectGuard: '퍼펙트 가드!',
          bannerInterrupt: '괴수 충전 차단!',
          bannerWaveClear: '괴수 격파! 체력 회복!',
          bannerVictory: '지구의 평화를 지켜냈습니다!',
          bannerDefeat: '컬러 타이머가 꺼졌습니다…'
        },
        controls: {
          left: '좌회피',
          right: '우회피',
          guard: '방어',
          punchL: '왼펀치',
          punchR: '오른펀치',
          disc: '광륜',
          beam: '광선',
          keyboardHint: 'A/D 회피 · S 방어 · J/K 펀치 · U 광륜 · Space 제페리온 광선'
        },
        result: {
          victoryTitle: '빛의 거인 · 올 클리어!',
          defeatTitle: '다시 일어서라, 티가!',
          totalScore: '최종 점수',
          defeated: '격파 괴수',
          maxCombo: '최대 콤보',
          perfectGuards: '퍼펙트 가드',
          playAgain: '다시 플레이',
          backHome: '홈으로'
        }
      }
    }
  },
  fr: {
    message: {
      title: 'Collection de jeux Fun4Gulu',
      home: 'Accueil',
      nav_games: 'Appuyez sur [↓] pour voir les jeux',
      games_list: '🎮 Liste de jeux',
      play: 'Jouer',
      language: 'Langue:',
      welcome: 'Bienvenue dans le monde du jeu rétro 8 bits !',
      loading: 'Chargement...',
      coming_soon: 'Plus de jeux à venir...',
      games: {
        "jump-cat": {
          title: 'Chat Sauteur',
          desc: 'Jeu de saut sensoriel ! Tenez-vous devant la caméra et sautez !'
        },
        "hurdle-cat": {
          title: 'Chat Haies',
          desc: 'Jeu de haies à la première personne ! Le chat avance constamment, sautez pour éviter les haies !'
        },
        tetris: {
          title: 'Tetris',
          desc: 'Tetris classique de console portable ! Déplacez, pivotez et effacez des lignes !'
        },
        retro: {
          title: 'Console Rétro',
          desc: 'Collection de cartouches rétro ! Émulateur GB/GBC/GBA/NES et 7 classiques homebrew.'
        },
        ultraman: {
          title: 'Ultraman Tiga Motion',
          desc: 'Combat 3D à la 3e personne ! Frappez, parez et lancez le Rayon Zepellion contre 5 kaiju !'
        },
        demo1: {
          title: 'Jeu de Démo 1',
          desc: 'Une simple démo de jeu web.'
        },
        demo2: {
          title: 'Jeu de Démo 2',
          desc: 'Explorez le monde pixel inconnu.'
        }
      },
      tetrisView: {
        title: 'Tetris',
        description: 'Tetris classique de console portable ! Déplacez et faites pivoter les pièces, effacez des lignes !',
        startButton: 'Démarrer',
        back: 'Retour',
        score: 'Score',
        level: 'Niveau',
        lines: 'Lignes',
        next: 'Suivante',
        item: 'Objet',
        itemEmpty: 'Vide',
        paused: 'En pause',
        clickToResume: 'Cliquez pour reprendre',
        gameOver: 'Game Over',
        finalScore: 'Score final',
        restartButton: 'Rejouer',
        instructions: '← → déplacer · ↓ chute rapide · ↑ pivoter · P pause (ou boutons tactiles ci-dessous)'
      },
      retroView: {
        title: 'Cartouches Rétro',
        hint: 'Insérez une cartouche et jouez (manette virtuelle sur tactile)',
        back: 'RETOUR',
        eject: 'ÉJECTER',
        license: 'Tous les jeux sont des homebrew librement diffusables'
      },
      jumpCatView: {
        title: 'Chat Sauteur',
        description: 'Tenez-vous devant la caméra et sautez pour marquer !',
        startButton: '🎮 Démarrer',
        back: 'Retour',
        score: 'Score',
        combo: 'Combo',
        debug: 'Débogage',
        stop: 'Arrêter',
        calibrating: 'Tenez-vous au centre, calibration en cours...'
      },
      hurdleCatView: {
        title: 'Chat Haies',
        description: 'Le chat avance constamment, sautez pour éviter les haies !',
        startButton: '🎮 Démarrer',
        back: 'Retour',
        score: 'Score',
        combo: 'Combo',
        debug: 'Débogage',
        stop: 'Arrêter',
        calibrating: 'Tenez-vous au centre, calibration en cours...',
        controlMode: 'Mode de contrôle',
        bodyMode: 'Corps',
        handMode: 'Main',
        instructionsBody: 'Penchez le corps pour changer de voie, sautez pour éviter les haies',
        instructionsHand: 'Levez la main gauche/droite pour changer de voie, les deux pour sauter'
      },
      ultramanView: {
        title: 'ULTRAMAN TIGA · COMBAT MOTION',
        subtitle: 'Devenez le Géant de Lumière et affrontez 5 kaiju dans le port !',
        cameraMode: 'Mode Caméra Motion',
        keyboardMode: 'Clavier / Tactile',
        selectStage: 'Choisir la vague',
        startButton: 'TRANSFORMATION !',
        loadingModel: 'Concentration de la lumière...',
        back: 'RETOUR',
        stop: 'QUITTER',
        score: 'SCORE',
        combo: 'COMBO',
        wave: 'VAGUE {current}/{total}',
        energy: 'ÉNERGIE LUMIÈRE',
        energyReady: 'Rayon Zepellion prêt !',
        energyFull: 'MAX ! Pose L / + pour le SUPER RAYON !',
        heroHp: 'PV TIGA',
        mute: 'MUET',
        unmute: 'SON',
        recenter: 'RECENTRER',
        skeleton: 'POSE',
        cameraError: 'Caméra indisponible. Vérifiez les permissions ou passez au clavier : ',
        switchToKeyboard: 'Jouer au clavier',
        moves: {
          punch: 'Coups de poing',
          punchDesc: 'Enchaînez gauche/droite',
          dodge: 'Esquive G/D',
          dodgeDesc: 'Évitez les boules de feu',
          guard: 'Bras en X',
          guardDesc: 'Bouclier Ultra',
          disc: 'Lever et trancher',
          discDesc: 'Disque Ultra Slash',
          beam: 'Pose L / +',
          beamDesc: 'Rayon Zepellion'
        },
        monsters: {
          baltan: 'Alien Baltan',
          ganq: 'Gan-Q',
          zetton: 'Zetton',
          'gomora-mecha': 'Mecha Gomora',
          gatanothor: 'Gatanothor'
        },
        hints: {
          hintStandCenter: 'Tenez-vous au centre, bras visibles',
          hintShowArms: 'Reculez un peu pour montrer vos deux bras',
          hintReady: 'Frappez ! Ou faites L / + pour le rayon',
          hintPunch: 'Ultra Punch !',
          hintGuardPrep: 'Croisez les bras pour parer…',
          hintGuardActive: 'Barrière Ultra active !',
          hintBeamCharge: 'Maintenez la pose L / +…',
          hintBeamFire: 'RAYON ZEPELLION !',
          hintDiscCharge: 'Levez une main pour charger le disque…',
          hintDiscThrow: 'Prêt ! Abaissez le bras !',
          hintDiscFire: 'ULTRA SLASH !'
        },
        warnings: {
          warningFireball: 'DANGER ! Boule de feu — Parez ou esquivez !',
          warningMelee: 'DANGER ! Charge du kaiju — Bras en X !',
          warningDarkBeam: 'ALERTE ! Rayon noir — Bras en X !'
        },
        banners: {
          bannerWaveStart: 'ALERTE KAIJU ! COMBAT !',
          bannerBeam: 'RAYON ZEPELLION !',
          bannerSuperBeam: 'SUPER RAYON ZEPELLION !',
          bannerDisc: 'ULTRA SLASH !',
          bannerPerfectGuard: 'PARADE PARFAITE !',
          bannerInterrupt: 'CHARGE INTERROMPUE !',
          bannerWaveClear: 'KAIJU VAINCU !',
          bannerVictory: 'PAIX RESTAURÉE ! VICTOIRE !',
          bannerDefeat: 'CHRONO ÉTEINT…'
        },
        controls: {
          left: 'GAUCHE',
          right: 'DROITE',
          guard: 'GARDE',
          punchL: 'POING G',
          punchR: 'POING D',
          disc: 'DISQUE',
          beam: 'RAYON',
          keyboardHint: 'A/D Esquive · S Garde · J/K Poing · U Disque · Espace Rayon'
        },
        result: {
          victoryTitle: 'GÉANT DE LUMIÈRE · VICTOIRE !',
          defeatTitle: 'RELÈVE-TOI, TIGA !',
          totalScore: 'SCORE FINAL',
          defeated: 'VAINCUS',
          maxCombo: 'COMBO MAX',
          perfectGuards: 'PARADES',
          playAgain: 'REJOUER',
          backHome: 'ACCUEIL'
        }
      }
    }
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  fallbackLocale: 'en',
  messages,
})
