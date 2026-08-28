/**
 * Chinese Simplified (简体中文) — TASK-458.
 *
 * Register follows the shipped ClawBox copy: the user is addressed politely
 * with 您 (the desktop and ClawKeep blocks use 您 almost exclusively), controls
 * are short verb phrases without a trailing 。 ("保存", "重试", "取消"), and
 * whole sentences end with 。/？ Full-width punctuation (，。：？（）“”) replaces
 * the English equivalents, but the em dash — the ellipsis … the arrow → and the
 * en dash in ranges (8–63, A–Z) are kept exactly as the English uses them, as
 * is the "..." spelling where English wrote three dots instead of one ellipsis.
 *
 * Terminology reused from the existing ~1300 shipped zh keys:
 *   Settings 设置 · Save 保存 · Cancel 取消 · Retry 重试 · Copy 复制 ·
 *   Copied 已复制 · Sign in 登录 · Provider 服务商 (settings.aiProvider) ·
 *   Model 模型 · Skill 技能 (store.confirmMessage) · Install 安装 ·
 *   Installed 已安装 · Password 密码 · device 设备 · box 这台 ClawBox ·
 *   agent 智能体 (wizard.completionHermesStarting) · API key API 密钥 ·
 *   dashboard 控制台 (openclaw.iframeTitle).
 * Two coinages, chosen because the literal renderings read wrong in zh:
 *   registry → 技能库 (「注册表」 reads as the Windows registry), and
 *   Setup (a requirements field) → 配置, so it does not collide with 设置.
 * OAuth "code" follows the wizard block's split, never 代码 (= source code):
 *   the PKCE code the user pastes back is 授权码 (ai.anthropicInputLabel),
 *   the device-flow code typed on the provider's page is 验证码 (ai.codeExpires).
 * ASCII space is kept around Latin/number runs inside Chinese text, matching
 * the existing block's typography ("{count} 个项目", "AI 服务商").
 *
 * Split keys: the *Prefix/*Suffix pairs are re-assembled around a <span>, so
 * each Chinese half is worded to join into one grammatical sentence — e.g.
 * 「这会更改您用于」+「网页登录、SSH 和 sudo」+「的密码。…」, which moves the
 * head noun into the suffix because Chinese puts the modifier first.
 */
export const zh: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "本地 AI",
  "settings.localModels": "本地模型",
  "settings.voice": "语音",

  // === System password card ===
  "settings.security.passwordLabel": "密码",
  "settings.security.passwordHintPrefix": "用于网页登录、SSH 和",
  "settings.security.passwordHintSuffix": "。在这里更新会同时更改这三项。",
  "settings.security.currentPassword": "当前密码",
  "settings.security.newPassword": "新密码",
  "settings.security.newPasswordPlaceholder": "新密码（至少 8 个字符）",
  "settings.security.confirmNewPassword": "确认新密码",
  "settings.security.hideCurrentPassword": "隐藏当前密码",
  "settings.security.showCurrentPassword": "显示当前密码",
  "settings.security.hideNewPassword": "隐藏新密码",
  "settings.security.showNewPassword": "显示新密码",
  "settings.security.hideConfirmPassword": "隐藏确认密码",
  "settings.security.showConfirmPassword": "显示确认密码",
  "settings.security.clearAndReenter": "清除并重新输入当前密码",
  "settings.security.reenter": "重新输入",
  "settings.security.checking": "检查中…",
  "settings.security.verify": "验证",
  "settings.security.passwordsDontMatchYet": "两次输入的密码尚不一致",
  "settings.security.saving": "保存中…",
  "settings.security.updatePassword": "更新密码",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "请记下这个密码",
  "settings.security.confirmBodyPrefix": "这会更改您用于",
  "settings.security.confirmBodyScope": "网页登录、SSH 和 sudo",
  "settings.security.confirmBodySuffix": "的密码。如果忘记，您可能会彻底无法登录这台设备，只能通过恢复出厂设置才能重新使用。",
  "settings.security.hidePassword": "隐藏密码",
  "settings.security.revealPassword": "显示密码",
  "settings.security.hide": "隐藏",
  "settings.security.reveal": "显示",
  "settings.security.confirmChange": "我已记下 — 更改密码",

  // === Validation and status ===
  "settings.security.errorTooShort": "新密码至少需要 8 个字符",
  "settings.security.errorMismatch": "两次输入的新密码不一致",
  "settings.security.errorSameAsCurrent": "新密码必须与当前密码不同",
  "settings.security.errorInvalidChars": "密码包含无效字符",
  "settings.security.verificationFailed": "验证失败",
  "settings.security.updateSuccess": "密码已更新。下次登录或使用 SSH 时请使用新密码。",
  "settings.security.failed": "失败",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "密码必须为 8–63 个字符",
  "settings.security.wifiPasswordUpdated": "{ssid} 的密码已更新",

  // === Panel chrome ===
  "hermesProvider.title": "AI 提供商",
  "hermesProvider.intro":
    "本设备运行在 Hermes 上。连接提供商并选择默认项——状态、登录与切换都在这里完成。",
  "hermesProvider.hero.nativeSwitch": "通过 Hermes 原生切换",
  "hermesProvider.continue": "继续",
  "hermesProvider.connected.affirmation": "已连接",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "一个 API 密钥，300+ 个模型",
  "hermesProvider.row.desc.anthropic": "Claude — 登录或使用 API 密钥",
  "hermesProvider.row.desc.openaiCodex": "使用 OpenAI (Codex) 登录",
  "hermesProvider.row.desc.gemini": "直连 Gemini 模型",
  "hermesProvider.row.desc.zai": "智谱 GLM 模型",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi（编程）",
  "hermesProvider.row.desc.copilot": "使用 GitHub 登录",
  "hermesProvider.row.desc.nous": "使用 Nous 登录",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "使用中",
  "hermesProvider.clawai.switching": "切换中…",
  "hermesProvider.clawai.switchTo": "切换到 {tier}",
  "hermesProvider.clawai.inUse": "正在使用 ClawBox AI",
  "hermesProvider.clawai.modelLabel": "模型：",
  "hermesProvider.clawai.finishingSetup": "正在此设备上完成设置…",
  "hermesProvider.clawai.nowActive": "ClawBox AI 现在是您正在使用的模型",
  "hermesProvider.clawai.switchFailed": "无法切换到 ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "使用 {provider} 登录",
  "hermesProvider.oauth.connectedDesc": "已连接。OAuth 凭据有效。",
  "hermesProvider.oauth.cliOnlyDesc": "此服务商需通过 Hermes CLI 登录。",
  "hermesProvider.oauth.availableDesc": "通过 Hermes 使用 OAuth（无需 API 密钥）。",
  "hermesProvider.oauth.connectedBadge": "已连接",
  "hermesProvider.oauth.signIn": "登录",
  "hermesProvider.oauth.tryAgain": "重试",
  "hermesProvider.oauth.cliInstructions": "请在设备终端中运行以下命令，然后重新打开此面板：",
  "hermesProvider.oauth.starting": "正在启动 {provider} 登录...",
  "hermesProvider.oauth.pkceInstructions":
    "已打开 {provider} 的登录标签页。请在该页面完成授权，复制页面上显示的授权码并粘贴到这里。",
  "hermesProvider.oauth.reopenSignInPage": "重新打开登录页面",
  "hermesProvider.oauth.codeLabel": "粘贴来自 {provider} 的授权码",
  "hermesProvider.oauth.submitting": "提交中...",
  "hermesProvider.oauth.submitCode": "提交授权码",
  "hermesProvider.oauth.startOver": "重新开始",
  "hermesProvider.oauth.deviceInstructions":
    "请在 {provider} 的验证页面输入此验证码。您完成授权后，本面板会自动更新。",
  "hermesProvider.oauth.copyCode": "复制验证码",
  "hermesProvider.oauth.copied": "已复制",
  "hermesProvider.oauth.openVerificationPage": "打开验证页面",
  "hermesProvider.oauth.waitingApproval": "等待授权...",
  "hermesProvider.oauth.orPasteKey": "…或改为在下方粘贴 API 密钥。",
  "hermesProvider.oauth.advancedLabel": "高级：",
  "hermesProvider.oauth.dashboardLink": "Hermes 控制台（仅限 LAN）",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Hermes 返回了意外的响应",
  "hermesProvider.oauth.startFailed": "无法开始登录",
  "hermesProvider.oauth.codeRejected": "授权码未被接受",
  "hermesProvider.oauth.expired": "登录请求已过期。请重试。",
  "hermesProvider.oauth.failed": "登录失败。请重试。",

  // === Model picker ===
  "hermesProvider.model.label": "默认模型",
  "hermesProvider.model.loading": "加载中…",
  "hermesProvider.model.noCredentials": "尚未为此服务商配置凭据",
  "hermesProvider.model.noModels": "没有可用的模型",
  "hermesProvider.model.savedElsewherePrefix": "此设备当前使用的是",
  "hermesProvider.model.savedElsewhereSuffix": "。保存后会切换到 {provider}。",
  "hermesProvider.model.staleColdStart": "Hermes 尚未发布模型列表 — 现在显示的是最简备用列表。",
  "hermesProvider.model.staleCached": "正在显示缓存的模型列表；无法访问 Hermes 的实时模型目录。",

  // === API key + save ===
  "hermesProvider.key.label": "{provider} API 密钥",
  "hermesProvider.key.placeholder": "粘贴 API 密钥（如已设置可留空）",
  "hermesProvider.save.button": "保存模型和服务商",
  "hermesProvider.save.saving": "保存中…",
  "hermesProvider.save.ok": "已保存",
  "hermesProvider.save.keySavedOk": "密钥已保存 — 服务商和模型均已更新",
  "hermesProvider.save.failed": "保存失败",
  "hermesProvider.save.keySavedNoCatalog":
    "{provider} 的密钥已保存，但它尚未发布模型列表 — 请稍后重新打开此面板并选择模型。",
  "hermesProvider.save.noCredentials": "{provider} 还没有凭据 — 请先登录或粘贴 API 密钥。",
  "hermesProvider.save.catalogUnavailable":
    "目前无法访问 Hermes 的模型列表，因此无法核对 {provider} 的模型。请稍后重试。",

  // === Header ===
  "skills.title": "Hermes 技能",
  "skills.subtitleWithCount": "有 {n} 个技能可供您的 Hermes 智能体使用",
  "skills.subtitleFallback": "为您的 Hermes 智能体添加更多能力",

  // === Tabs ===
  "skills.tablistLabel": "技能视图",
  "skills.tabInstalled.withCount": "已安装（{n}）",
  "skills.tabInstalled.empty": "已安装",
  "skills.tabBrowse": "浏览",

  // === Search and filters ===
  "skills.searchPlaceholder": "搜索技能…",
  "skills.searchLabel": "搜索技能",
  "skills.searchBusy": "加载中",
  "skills.clearSearch": "清除搜索",
  "skills.sortLabel": "排序",
  "skills.sortOptions.relevance": "最佳匹配",
  "skills.sortOptions.name": "名称 A–Z",
  "skills.sortOptions.trust": "最受信任",
  "skills.sortOptions.popular": "安装最多",
  "skills.sourceLabel": "来源",
  "skills.providerLabel": "发布者",
  "skills.categoryLabel": "分类",
  "skills.filtersHeading": "筛选",
  "skills.filtersButton": "筛选",
  "skills.filtersButtonWithCount": "筛选 ({n})",
  "skills.filtersClearAll": "全部清除",
  "skills.filtersClose": "关闭筛选",
  "skills.filtersShowAll": "再显示 {n} 项",
  "skills.filtersShowFewer": "收起",
  "skills.filtersNone": "暂时没有可筛选的内容。",
  "skills.filterChipRemove": "移除筛选 {group}：{value}",
  "skills.facetTrust": "可信度",
  "skills.facetSafety": "安全性",
  "skills.trustBucket.official": "官方",
  "skills.trustBucket.trusted": "受信任",
  "skills.trustBucket.community": "社区",
  "skills.trustBucket.unknown": "未知",
  "skills.safetyBucket.safe": "扫描通过",
  "skills.safetyBucket.caution": "已标记",
  "skills.safetyBucket.dangerous": "危险",
  "skills.safetyBucket.unscanned": "未扫描",
  "skills.facetCategoryCoverage": "{total} 个中有 {n} 个标明了类别。",
  "skills.facetCountsLoaded": "计数仅涵盖已加载的 {n} 个技能，而非整个目录。",
  "skills.facetSafetyBrowseNote": "安全性在安装时检查，因此只能在“已安装”中筛选。",
  "skills.liveResults.one": "有 {n} 个技能匹配",
  "skills.liveResults.other": "有 {n} 个技能匹配",
  "skills.liveResults.none": "没有匹配的技能",
  "skills.emptyFiltered": "没有内容符合这些筛选条件",
  "skills.emptyCatalog": "这里还没有内容",
  "skills.showingRange": "显示第 {from}–{to} 个，共 {total} 个",
  "skills.degradedCount": "最匹配的 {n} 个结果 — 请细化搜索以缩小范围",
  "skills.loadMore": "加载更多",
  "skills.loadingMore": "正在加载更多技能…",

  // === Scan verdicts ===
  "skills.scanPassed": "扫描通过",
  "skills.scanFlagged.one": "扫描发现 {n} 项问题",
  "skills.scanFlagged.other": "扫描发现 {n} 项问题",
  "skills.notScanned": "未扫描",

  // === Where a skill came from ===
  "skills.originBuiltin": "内置",
  "skills.originHub": "已安装",
  "skills.originLocal": "本机创建",
  "skills.originLocalHelp": "由您的智能体在此设备上编写 — 并非来自技能库。",

  // === Actions ===
  "skills.install": "安装",
  "skills.installing": "安装中…",
  "skills.installed": "已安装",
  "skills.remove": "移除",
  "skills.removing": "移除中…",
  "skills.retry": "重试",
  "skills.builtinLocked": "已可用（内置）",
  "skills.cancel": "取消",

  // === Install / remove confirmation ===
  "skills.installTitle": "安装 {name}？",
  "skills.installTrustedBody": "此技能在您的 Hermes 智能体中运行。Hermes 会在启用前对其进行扫描。",
  "skills.installCommunityBody": "由社区贡献，未经 ID Robots 审核。请核对下方的标识符是否与您预期的发布者一致。",
  "skills.installWillAsk": "需要您提供：{labels}",
  "skills.uninstallTitle": "移除 {name}？",
  "skills.uninstallBody.withPath": "这会从您的智能体中删除 {path}。您可以随时从“浏览”重新安装。",
  "skills.uninstallBody.generic": "这会从您的智能体中删除该技能。您可以随时从“浏览”重新安装。",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "正在安装 {name}",
  "skills.liveInstalled": "{name} 已安装",
  "skills.liveInstallFailed": "无法安装 {name}",
  "skills.installFailed": "安装失败",
  "skills.liveRemoving": "正在移除 {name}",
  "skills.liveRemoved": "{name} 已移除",
  "skills.liveRemoveFailed": "无法移除 {name}",
  "skills.uninstallFailed": "移除失败",

  // === Empty and error states ===
  "skills.emptySearch": "没有技能匹配“{q}”",
  "skills.emptySearchHint": "请换一个词试试。",
  "skills.emptyInstalled": "尚未安装任何技能",
  "skills.emptyInstalledHint": "浏览技能库即可添加更多能力。",
  "skills.browseSkills": "浏览技能",
  "skills.installedError": "无法读取您已安装的技能。",
  "skills.installedStale": "无法刷新此列表 — 显示的是最后一次已知状态。",
  "skills.buildingCatalog": "正在构建技能目录 — 新设备首次浏览大约需要一分钟。",
  "skills.buildingCatalogAuto": "目录准备好后技能就会出现在这里 — 您可以让此页面一直开着。",
  "skills.catalogStale": "目录上次下载是在 {when}。",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "有 {n} 个技能都叫“{q}”。请选择您要的那一个：",
  "skills.ambiguousPickFirst": "在下方选择一个进行安装",

  // === Platform compatibility ===
  "skills.platformWarning": "需要 {platforms} — 此技能无法在您的 ClawBox 上运行。",
  "skills.platformOnly": "仅限 {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "使用要求",
  "skills.sectionGlance": "概览",
  "skills.sectionAbout": "关于",
  "skills.sectionSecurity": "安全与来源",
  "skills.sectionRelated": "相关技能",
  "skills.sectionDocs": "文档",
  "skills.docsOutline": "本文档目录",
  "skills.docsSections": "{n} 个章节",
  "skills.readMore": "阅读更多",
  "skills.showLess": "收起",
  "skills.docsFull": "完整 SKILL.md",
  "skills.docsPreview": "文档预览 — 完整内容在安装后可见",
  "skills.docsLoading": "正在加载文档…",
  "skills.docsUnavailable": "此技能暂无可用文档。",

  // === Requirements card ===
  "skills.reqCommands": "命令",
  "skills.reqCommandPresent": "此设备上可用",
  "skills.reqCommandMissing": "未安装",
  "skills.reqEnvVars": "环境变量",
  "skills.reqDependencies": "软件包",
  "skills.reqCredentials": "凭据文件",
  "skills.reqCompatibility": "兼容性",
  "skills.reqSetup": "配置",
  "skills.reqSecrets": "需要您提供",
  "skills.reqGetKey": "获取密钥",
  "skills.reqSetupGuide": "配置指南",

  // === Provenance card ===
  "skills.provSource": "来源",
  "skills.provSourceUnverified": "发布者网站（未验证）",
  "skills.provRepo": "代码仓库",
  "skills.provDetailPage": "详情页",
  "skills.provHomepage": "主页",
  "skills.provInstallCommand": "安装命令",
  "skills.provWeeklyInstalls": "安装量",
  "skills.provContentHash": "内容哈希",
  "skills.showAllFindings": "显示全部 {n} 项问题",
  "skills.copyIdentifier": "复制标识符",
  "skills.copied": "已复制",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "版本",
  "skills.fieldAuthor": "作者",
  "skills.fieldLicense": "许可证",
  "skills.fieldCategory": "分类",
  "skills.fieldPlatforms": "平台",
  "skills.fieldSize": "大小",
  "skills.fieldIncludes": "包含",
  "skills.fieldInstalled": "安装时间",
  "skills.fieldUpdated": "更新时间",
  "skills.fileCount.one": "{n} 个文件",
  "skills.fileCount.other": "{n} 个文件",
  "skills.installedAgo": "{when}安装",

  // === Navigation ===
  "skills.back": "返回技能列表",
  "skills.breadcrumbLabel": "面包屑导航",
  "skills.breadcrumbBrowse": "浏览",
  "skills.breadcrumbInstalled": "已安装",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "刚刚",
  "skills.relative.minutes": "{n} 分钟前",
  "skills.relative.hours": "{n} 小时前",
  "skills.relative.days.one": "{n} 天前",
  "skills.relative.days.other": "{n} 天前",
  "skills.relative.months.one": "{n} 个月前",
  "skills.relative.months.other": "{n} 个月前",
  "skills.relative.years": "{n} 年前",

  // === Run state ===
  "localModels.run.running": "开启",
  "localModels.run.idle": "关闭",
  "localModels.run.onDemand": "按需启动",
  "localModels.run.notInstalled": "未安装",
  "localModels.run.notOnThisEdition": "此版本不提供",

  // === Panel ===
  "localModels.intro": "在这台设备上运行的 AI，以及每个部分当前的状态。",
  "localModels.unavailable": "无法读取以下模型的状态：{list}。",
  "localModels.disk": "磁盘 {size}",
  "localModels.memoryInUse": "已用内存 {size}",
  "localModels.footer": "关闭的项目在重启后仍保持关闭。",
  "localModels.group.llm": "AI 助手模型",
  "localModels.group.tts": "语音（文字转语音）",
  "localModels.group.stt": "语音转文字",
  "localModels.group.other": "其他",
  "localModels.role.primary": "首选",
  "localModels.role.fallback": "备用",
  "localModels.menu.more": "{name} 的更多操作",
  "localModels.menu.install": "安装",
  "localModels.menu.enable": "启用",
  "localModels.menu.disable": "停用",
  "localModels.menu.makePrimary": "设为首选",
  "localModels.menu.useAsFallback": "用作备用",
  "localModels.menu.turnOffLocalAi": "关闭本地 AI",
  "localModels.menu.manageInClawKeep": "在 ClawKeep 中管理",
  "localModels.localOnly.title": "仅本地模式",
  "localModels.localOnly.hint": "所有请求都交给本地模型处理。会停用所有云端 AI 提供商，包括备用。",

  // === Errors ===
  "localModels.error.changeFailed": "无法更改该模型。",
  "localModels.error.unreachable": "无法连接到这台 ClawBox，因此无法更改该模型。",

  // === Desktop & power (TASK-455) ===
  "systemProfile.title": "桌面与电源",
  "systemProfile.desktopLabel": "桌面环境",
  "systemProfile.desktopHelp": "在设备的 HDMI 输出和远程桌面上运行完整的 GNOME 桌面。关闭后设备以无头模式运行，可释放约 700 MB 内存——不会卸载任何组件，随时可以重新开启。",
  "systemProfile.performanceLabel": "性能模式",
  "systemProfile.performanceHelp": "将 CPU 和 GPU 锁定在最高频率，而不是让它们动态调节。首个 token 更快，但空闲功耗会升到约 7.2 W，持续本地推理实测为 74.8 °C，略高于 74 °C 的被动散热上限。除非要跑长任务且散热良好，否则请保持关闭。",
  "systemProfile.rebootRequired": "重启设备以应用此更改。",
  "systemProfile.unsupported": "此设备不支持。",
  "systemProfile.powerState": "电源配置：{profile} · 频率：{clocks}",
  "systemProfile.clocksPinned": "锁定",
  "systemProfile.clocksDynamic": "动态",
  "systemProfile.memoryGuards": "当前内存上限：本地 AI {ollama}，浏览器 {browser}，桌面 {desktop}。本地 AI 同时处理 {parallel} 个请求。",
  "systemProfile.loadFailed": "无法读取桌面与电源设置。",
  "systemProfile.desktopFailed": "无法更改桌面设置。",
  "systemProfile.powerFailed": "无法更改电源配置。",

  // === TASK-452: skills store safety (flagged skills, incomplete downloads, keys) ===
  "skills.dangerTitle": "安装“{name}”前请先确认",
  "skills.dangerLead": "本设备已扫描该技能并将其标记为“{verdict}”。是否安装由您决定。",
  "skills.dangerSeverity": "扫描发现 {critical} 项严重问题和 {high} 项高风险问题。",
  "skills.dangerCanDo": "该技能在您的设备上能做什么",
  "skills.dangerNoCapabilities": "扫描未能说明该技能会触及设备的哪一部分。",
  "skills.dangerOther.one": "还有 {n} 项扫描无法归类的发现。",
  "skills.dangerOther.other": "还有 {n} 项扫描无法归类的发现。",
  "skills.dangerTrustNote": "发布者的声誉并不能改变这一点：每个技能都会被扫描，每个被标记的技能都由您确认。",
  "skills.dangerShowFindings": "查看扫描的 {n} 项发现",
  "skills.dangerUnderstand": "我已了解该技能能做什么，仍要安装。",
  "skills.dangerInstallAnyway": "仍要安装",
  "skills.dangerCancel": "不安装",
  "skills.capability.shell": "在您的设备上执行命令",
  "skills.capability.filesystem": "读取、修改或删除您的文件",
  "skills.capability.network": "通过互联网收发数据",
  "skills.capability.credentials": "读取您保存的密钥、令牌和密码",
  "skills.capability.browser": "控制您设备上的浏览器",
  "skills.capability.system": "更改系统设置或安装软件",
  "skills.capability.agentInstructions": "修改您的助手所遵循的指令",
  "skills.capability.other": "扫描标记出但无法说明的内容",
  "skills.installIncomplete": "下载不完整 — 缺少：{files}",
  "skills.installIncompleteHint": "未安装任何内容。请检查网络连接后重试。",
  "skills.nameConflict": "“{name}”是本设备自带的技能。",
  "skills.nameConflictHint": "内置技能随设备更新，不通过商店更新。",
  "skills.installRepaired.one": "已补全下载：安装程序遗漏的 {n} 个文件。",
  "skills.installRepaired.other": "已补全下载：安装程序遗漏的 {n} 个文件。",
  "skills.skillDisabled": "已停用",
  "skills.skillDisabledHelp": "已安装但已关闭 — 助手不会使用它。",
  "skills.countDisabled": "{n} 个已停用",
  "skills.secretSaveLabel": "输入{label}",
  "skills.secretPlaceholder": "在此粘贴密钥",
  "skills.secretSave": "保存密钥",
  "skills.secretSaving": "正在保存…",
  "skills.secretSaved": "密钥已保存",
  "skills.secretStored": "已保存在本设备",
  "skills.secretClear": "移除密钥",
  "skills.secretFailed": "无法保存该密钥。",
  "skills.secretHelp": "密钥仅保存在本设备上，且不会再次显示。",

  // The Coding Agent app (the assistant's delegated Claude Code runs).
  "codingAgent.title": "编程助手",
  "codingAgent.chatWorking": "编程助手正在工作",
  "codingAgent.chatWorkingOwner": "你的任务正在运行",  "codingAgent.chatFinished": "编程助手已完成",
  "codingAgent.chatFailed": "编程助手未能完成",
  "codingAgent.chatStopped": "编程助手已停止",

  "codingAgent.chatOpenApp": "打开",
  "codingAgent.chatAgents": "{n} 个代理",
  "codingAgent.chatLiveWork": "实时工作",
  "codingAgent.chatScreenshot": "屏幕截图",
  "codingAgent.chatLookingAtPage": "正在查看页面",
  "codingAgent.chatOpeningPage": "正在打开页面",
  "codingAgent.chatDrivingPage": "正在操作页面",
  "codingAgent.chatClosingPage": "正在关闭页面",
  "codingAgent.chatWrite": "写入",
  "codingAgent.chatEdit": "编辑",
  "codingAgent.chatRead": "读取",
  "codingAgent.chatFilesTouched": "个文件已更改",
  "codingAgent.chatTurns": "轮",
  "codingAgent.noticeOpen": "打开编程助手",
  "codingAgent.noticeDismiss": "忽略",
  "codingAgent.switchLabel": "允许助手委派编程工作",
  "codingAgent.folderLabel": "项目文件夹",
  "codingAgent.folderPlaceholder": "/home/clawbox/Projects",
  "codingAgent.folderSave": "保存",
  "codingAgent.folderFailed": "无法保存默认文件夹。",
  "codingAgent.claudeCode": "Claude Code",
  "codingAgent.wrapper": "claude-ds",
  "codingAgent.clawai": "ClawBox AI",
  "codingAgent.missing": "缺失",
  "codingAgent.notConnected": "未连接",
  "codingAgent.effortLabel": "思考强度",
  "codingAgent.effort.low": "低",
  "codingAgent.effort.xhigh": "很高",
  "codingAgent.effort.max": "最高",
  "codingAgent.effortFailed": "无法更改思考强度。",
  "codingAgent.thinking": "思考中 · {n} 个词元",
  "codingAgent.more": "显示更多",
  "codingAgent.tokensWord": "词元",
  "codingAgent.updated": "更新于",
  "codingAgent.githubOff": "未连接",
  "codingAgent.githubUnreachable": "无法连接 GitHub",
  "codingAgent.githubNotRunnable": "gh 已安装但无法启动 — 请检查其权限",
  "codingAgent.githubConnect": "连接",
  "codingAgent.githubReconnect": "更改",
  "codingAgent.githubOut": "退出登录",
  "codingAgent.githubOutConfirm": "再次点击以退出",
  "codingAgent.githubOutFailed": "无法断开 GitHub 连接。",
  "codingAgent.backup": "备份",
  "codingAgent.backupBusy": "备份中…",
  "codingAgent.backupDone": "已备份到 {repo}",
  "codingAgent.backupFailed": "无法备份到 GitHub。",
  "codingAgent.recentRuns": "最近的运行",  "codingAgent.clearRuns": "清除历史记录",
  "codingAgent.clearConfirm": "再次点击以清除",
  "codingAgent.clearFailed": "无法清除历史记录。",

  "codingAgent.noRuns": "还没有运行记录。让助手在某个代码项目里构建或修改点什么吧。",
  "codingAgent.statusRunning": "运行中",
  "codingAgent.statusCompleted": "已完成",
  "codingAgent.statusFailed": "未完成",
  "codingAgent.statusStopped": "已停止",
  "codingAgent.startedByAgent": "由助手发起",
  "codingAgent.startedByOwner": "由你发起",
  "codingAgent.runMeta": "{turns} 轮 · {files} 个文件已更改 · {duration}",
  "codingAgent.denials": "{n} 项操作未被允许",
  "codingAgent.deniedTitle": "不被允许",
  "codingAgent.artifactsTitle": "本次运行的证据",
  "codingAgent.githubDeviceIntro": "在 github.com 上输入此代码以连接你的账户：",
  "codingAgent.githubDeviceOpen": "打开 github.com/login/device",
  "codingAgent.githubDeviceWaiting": "等待输入代码…",
  "codingAgent.githubDeviceCancel": "取消",
  "codingAgent.githubDeviceTerminal": "改用终端",
  "codingAgent.githubStartFailed": "无法开始 GitHub 登录",
  "codingAgent.harnessTest": "测试运行框架",
  "codingAgent.harnessTestFailed": "无法启动框架测试",
  "codingAgent.deniedHelp": "编码助手只能在自己的文件夹内运行固定的一组命令。这是安全限制在起作用，并非故障——运行通常会找到其他办法。",
  "codingAgent.stop": "停止",
  "codingAgent.openLive": "实时查看",
  "codingAgent.openResume": "在终端中打开",
  "codingAgent.showDetails": "显示详情",
  "codingAgent.hideDetails": "隐藏详情",
  "codingAgent.loadFailed": "无法读取编程助手的设置。",
  "codingAgent.toggleFailed": "无法更改编程助手的设置。",
  "codingAgent.stopFailed": "无法停止本次运行。",
};
