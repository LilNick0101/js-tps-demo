/**
 * HUD – manages all in-game UI overlay elements.
 *
 * Lifecycle:
 *   const hud = new HUD();
 *   hud.init();                                  // call once when game starts
 *   hud.updateHealth(75);
 *   hud.showRespawnCountdown(3000);              // ms until respawn
 *   hud.updateScoreboard(playerScores, myId);
 *   hud.destroy();                               // call when returning to menu
 */
export default class HUD {
    constructor() {
        /** @type {Map<string, HTMLElement>} id -> element */
        this._els = new Map();
        this._respawnInterval = null;
        this._matchOverlayInterval = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /** Create and mount all HUD elements. */
    init() {
        this._createHealthBar();
        this._createShieldBar();
        this._createArmorBar();
        this._createAmmoCounter();
        this._createAbilityBar();
        this._createKillMessage();
        this._createKillFeed();
        this._createKillStreak();
        this._createScoreboards();
        this._createCrosshair();
        this._createHitmarker();
        this._createRespawnOverlay();
        this._createMatchEndOverlay();
        this._createSelfEffectBar();
        this._createScreenTintOverlay();
        this._createDebugOverlay();
        this._createTopBar();
        this._selfEffectKeys = new Map(); // key -> HTMLElement
    }

    /** Remove all HUD elements from the DOM. */
    destroy() {
        this._stopRespawnCountdown();
        this._stopMatchOverlayCountdown();
        this._els.forEach(el => el.remove());
        this._els.clear();
    }

    _teamMeta(teamId) {
        switch (teamId) {
            case 1: return { name: 'Red', color: '#ff5b5b', short: 'R' };
            case 2: return { name: 'Blue', color: '#56a0ff', short: 'B' };
            default: return { name: 'Neutral', color: '#c9c9c9', short: 'N' };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shield
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {number} shield   – current shield value
     * @param {number} shieldMax – maximum (defaults to 80)
     */
    updateShield(shield, shieldMax = 80) {
        const fill = this._els.get('shield-fill');
        const text = this._els.get('shield-text');
        if (!fill || !text) return;
        const pct = shieldMax > 0 ? Math.max(0, Math.min(100, (shield / shieldMax) * 100)) : 0;
        fill.style.width = `${pct}%`;
        text.textContent = `${Math.round(shield)} SH`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Armor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {number} armor   – current armor value
     * @param {number} armorMax – maximum (defaults to 80)
     */
    updateArmor(armor, armorMax = 80) {
        const fill = this._els.get('armor-fill');
        const text = this._els.get('armor-text');
        if (!fill || !text) return;
        const pct = armorMax > 0 ? Math.max(0, Math.min(100, (armor / armorMax) * 100)) : 0;
        fill.style.width = `${pct}%`;
        text.textContent = `${Math.round(armor)} AR`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ammo
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {number} ammo        – current clip rounds
     * @param {number} reserveAmmo – total reserve ammo
     */
    updateAmmo(ammo) {
        const el = this._els.get('ammo-counter');
        if (!el) return;
        el.textContent = `${ammo}  |  ∞`;
        // Flash red when clip is almost empty
        el.style.color = ammo <= 5 ? '#ff4444' : '#fff';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ability cooldowns
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {{ ability1Cooldown, ability2Cooldown, ultimateCooldown, ultimateActive }} data
     * @param {{ SHADOW_LIGHTNING_CD, SHADOW_TELEPORT_CD, SHADOW_STORM_CD,
     *           SHOCK_GRENADE_CD, WILLPOWER_CD, CLUSTER_STRIKE_CD, ... }} maxCds – optional override
     */
    updateAbilityCooldowns({ ability1Cooldown = 0, ability2Cooldown = 0, ultimateCooldown = 0, ultimateActive = 0 } = {},
                            maxCds = { a1: 600, a2: 480, ult: 3600 }) {
        const updateSlot = (slotId, current, max, active) => {
            const slot  = this._els.get(slotId);
            if (!slot) return;
            const cover = slot.querySelector('.ability-cd-cover');
            if (!cover) return;
            if (active) {
                cover.style.background = 'rgba(255, 200, 0, 0.35)';
                cover.style.height = '0%';
            } else if (current > 0 && max > 0) {
                const pct = Math.min(100, (current / max) * 100);
                cover.style.background = 'rgba(196, 194, 194, 0.75)';
                cover.style.height = `${pct}%`;
            } else {
                cover.style.height = '0%';
            }
        };
        updateSlot('ability-slot-1', ability1Cooldown, maxCds.a1, false);
        updateSlot('ability-slot-2', ability2Cooldown, maxCds.a2, false);
        updateSlot('ability-slot-3', ultimateCooldown,  maxCds.ult, ultimateActive === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Health
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {number} health    – current HP
     * @param {number} maxHealth – hero's maximum HP (default 100)
     */
    updateHealth(health, maxHealth = 100) {
        const fill = this._els.get('health-fill');
        const text = this._els.get('health-text');
        if (!fill || !text) return;

        const pct = Math.max(0, Math.min(100, (health / maxHealth) * 100));
        fill.style.width = `${pct}%`;

        // Colour shifts from green→orange→red as health drops
        if (pct > 60)       fill.style.background = 'linear-gradient(90deg, #00cc00, #00ff00)';
        else if (pct > 30)  fill.style.background = 'linear-gradient(90deg, #cc6600, #ffaa00)';
        else                fill.style.background = 'linear-gradient(90deg, #cc0000, #ff3300)';

        text.textContent = `${Math.round(health)} / ${Math.round(maxHealth)} HP`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Respawn overlay
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Show the respawn overlay and count down from the given delay.
     * @param {number} delayMs - milliseconds until respawn
     */
    showRespawnCountdown(delayMs,killerDisplay) {
        const overlay  = this._els.get('respawn-overlay');
        const countdown = this._els.get('respawn-countdown');
        const title = this._els.get('respawn-title');
        if (!overlay || !countdown) return;

        this._stopRespawnCountdown(); // cancel any previous timer

        overlay.style.display = 'flex';
        title.textContent = `KILLED BY ${killerDisplay}`;

        let remaining = Math.ceil(delayMs / 1000);
        countdown.textContent = remaining;

        this._respawnInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                countdown.textContent = '...';
                this._stopRespawnCountdown();
            } else {
                countdown.textContent = remaining;
            }
        }, 1000);
    }

    /** Hide the respawn overlay (called when server confirms respawn). */
    hideRespawnCountdown() {
        this._stopRespawnCountdown();
        const overlay = this._els.get('respawn-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    // ─────────────────────────────────────────────────────────────────────────    // Self-effect status chips
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Show a persistent status chip (e.g. "IRON STAND ACTIVE").
     * Call hideSelfEffect(key) to remove it.
     * @param {string} key         – unique identifier so it can be removed later
     * @param {string} text        – label text
     * @param {string} borderColor – CSS border/glow colour
     */
    showSelfEffect(key, text, borderColor = '#fff') {
        const bar = this._els.get('self-effect-bar');
        if (!bar) return;
        // Remove existing chip with same key
        this.hideSelfEffect(key);
        const chip = document.createElement('div');
        chip.style.cssText = `
            display: inline-block;
            padding: 5px 14px;
            background: rgba(0,0,0,0.7);
            border: 2px solid ${borderColor};
            border-radius: 20px;
            color: ${borderColor};
            font-family: Arial, sans-serif;
            font-size: 13px;
            font-weight: bold;
            letter-spacing: 1px;
            text-transform: uppercase;
            text-shadow: 0 0 8px currentColor;
            box-shadow: 0 0 10px ${borderColor}44;
            animation: hud-pulse 1.2s ease-in-out infinite;
        `;
        chip.textContent = text;
        bar.appendChild(chip);
        this._selfEffectKeys?.set(key, chip);
    }

    /** Remove a self-effect chip by key. */
    hideSelfEffect(key) {
        const chip = this._selfEffectKeys?.get(key);
        if (chip) { chip.remove(); this._selfEffectKeys.delete(key); }
    }

    removeAllSelfEffects() {
        this._selfEffectKeys?.forEach(chip => chip.remove());
        this._selfEffectKeys.clear();
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Screen-tint overlay (Iron Stand golden border, Shadow Realm dark veil)
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Show a full-screen tint overlay with an optional message.
     * @param {string} key     – used to match showScreenTint/hideScreenTint calls
     * @param {string} bg      – CSS background value (e.g. 'rgba(255,200,0,0.15)')
     * @param {string} border  – CSS box-shadow inner ring colour
     * @param {string} [label] – optional large text in the centre of the screen
     */
    showScreenTint(key, bg, border, label = '') {
        const overlay = this._els.get('screen-tint');
        if (!overlay) return;
        overlay.dataset.key = key;
        overlay.style.background = bg;
        overlay.style.boxShadow  = `inset 0 0 80px 20px ${border}`;
        overlay.style.display    = 'block';
        const lbl = overlay.querySelector('.screen-tint-label');
        if (lbl) lbl.textContent = label;
    }

    hideScreenTint(key) {
        const overlay = this._els.get('screen-tint');
        if (!overlay) return;
        if (overlay.dataset.key === key || !key) {
            overlay.style.display = 'none';
        }
    }

    removeScreenTint() {
        const overlay = this._els.get('screen-tint');
        if (overlay) overlay.style.display = 'none';
    }

    // ───────────────────────────────────────────────────────────────────────────    // Kill notifications
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Add a line to the kill feed (top-right).
     * Auto-removes after 6 s, max 5 visible entries.
     * @param {string} message
     */
    addKillFeedEntry(message) {
        const feed = this._els.get('kill-feed');
        if (!feed) return;

        const entry = document.createElement('div');
        entry.textContent = message;
        entry.style.cssText = 'margin:5px 0;background:rgba(0,0,0,0.7);padding:5px;border-radius:3px;';
        feed.insertBefore(entry, feed.firstChild);

        setTimeout(() => entry.remove(), 6000);

        while (feed.children.length > 5) feed.lastChild.remove();
    }

    /**
     * Add a kill feed row with team-colored names.
     */
    addKillFeedEntryTeam(killerName, killerTeam, victimName, victimTeam) {
        const feed = this._els.get('kill-feed');
        if (!feed) return;

        const killer = this._teamMeta(killerTeam);
        const victim = this._teamMeta(victimTeam);

        const entry = document.createElement('div');
        entry.style.cssText = 'margin:5px 0;background:rgba(0,0,0,0.7);padding:5px 8px;border-radius:3px;font-family:Arial,sans-serif;font-size:14px;';

        const killerSpan = document.createElement('span');
        killerSpan.style.color = killer.color;
        killerSpan.style.fontWeight = 'bold';
        killerSpan.textContent = killerName;

        const arrowSpan = document.createElement('span');
        arrowSpan.style.color = '#ffffff';
        arrowSpan.textContent = ' -> ';

        const victimSpan = document.createElement('span');
        victimSpan.style.color = victim.color;
        victimSpan.style.fontWeight = 'bold';
        victimSpan.textContent = victimName;

        entry.appendChild(killerSpan);
        entry.appendChild(arrowSpan);
        entry.appendChild(victimSpan);
        feed.insertBefore(entry, feed.firstChild);

        setTimeout(() => entry.remove(), 6000);
        while (feed.children.length > 5) feed.lastChild.remove();
    }

    /**
     * Flash a "You fragged X!" message in the centre of the screen.
     * @param {string} username
     */
    showKillMessage(username) {
        const el = this._els.get('kill-message');
        if (!el) return;
        el.textContent = `You fragged ${username}!`;
        el.style.opacity = '1';
        setTimeout(() => { el.style.opacity = '0'; }, 2000);
    }

    /**
     * Flash a kill-streak name in the centre of the screen.
     * @param {string} streakName
     */
    showKillStreak(streakName) {
        const el = this._els.get('kill-streak');
        if (!el) return;
        el.textContent = streakName.toUpperCase() + '!';
        el.style.opacity = '1';
        setTimeout(() => { el.style.opacity = '0'; }, 2000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Hitmarker
    // ─────────────────────────────────────────────────────────────────────────

    /** Flash the hitmarker for 150 ms. */
    showHitmarker() {
        const el = this._els.get('hitmarker');
        if (!el) return;
        el.style.opacity = '1';
        setTimeout(() => { el.style.opacity = '0'; }, 150);
    }

    updateDebugInfo(info,ping) {
        const el = this._els.get('debug-overlay');
        if (!el) return;
        el.textContent = `Socket ID: ${info.id}\n` +
            `Name: ${info.name}\n` +
            `Position: (${info.x}, ${info.y}, ${info.z})\n` +
            `Ping: ${ping} ms\n`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scoreboards
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Refresh both the full scoreboard and the mini scoreboard.
     * @param {Object<string, {id:string, name:string, kills:number, deaths:number}>} playerScores
     * @param {string} myId
     */
    updateScoreboard(playerScores, myId, matchState = null) {
        const entries = Object.values(playerScores);
        entries.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const heroes = {
            0: 'Dummy',
            1: 'Sven',
            2: 'Tamerlane',
            3: 'Father Callas',
            4: 'Selene',
            5: 'Fat Jerome',
            6: 'Kyoukan',
            7: 'Templar'
        };

        const red = Number(matchState?.teamScores?.[1] ?? 0);
        const blue = Number(matchState?.teamScores?.[2] ?? 0);
        const target = Number(matchState?.targetScore ?? 100);

        const topRed = this._els.get('topbar-red-score');
        const topBlue = this._els.get('topbar-blue-score');
        if (topRed) topRed.textContent = `Red ${red}`;
        if (topBlue) topBlue.textContent = `Blue ${blue}`;

        const totals = this._els.get('scoreboard-team-totals');
        if (totals) {
            totals.innerHTML = `<span style="color:#ff5b5b;font-weight:bold;">Red: ${red}</span> <span style="color:#ccc;">vs</span> <span style="color:#56a0ff;font-weight:bold;">Blue: ${blue}</span> <span style="color:#aaa;">(Target ${target})</span>`;
        }

        // Full scoreboard
        const tbody = document.getElementById('scoreboard-body');
        if (tbody) {
            tbody.innerHTML = '';
            entries.forEach((entry, i) => {
                const kd = entry.deaths > 0
                    ? (entry.kills / entry.deaths).toFixed(2)
                    : entry.kills.toFixed(2);
                const tr = document.createElement('tr');
                if (entry.id === myId) tr.classList.add('is-me');
                const team = this._teamMeta(entry.team || 0);
                tr.innerHTML = `
                    <td class="rank">${i + 1}</td>
                    <td class="name" style="color:${team.color}">[${team.short}] ${entry.name}</td>
                    <td class="hero">${heroes[entry.hero] || 'Unknown'}</td>
                    <td>${entry.kills}</td>
                    <td>${entry.deaths}</td>
                    <td class="kd">${kd}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        // Mini scoreboard (top 5)
        const miniRows = document.getElementById('mini-scoreboard-rows');
        if (miniRows) {
            miniRows.innerHTML = '';
            entries.slice(0, 5).forEach((entry, i) => {
                const row = document.createElement('div');
                row.className = 'ms-row' + (entry.id === myId ? ' is-me' : '');
                const team = this._teamMeta(entry.team || 0);
                row.innerHTML = `
                    <span class="ms-rank">${i + 1}</span>
                    <span class="ms-name" style="color:${team.color}">[${team.short}] ${entry.name}</span>
                    <span class="ms-kills">${entry.kills}</span>
                `;
                miniRows.appendChild(row);
            });
        }
    }

    updateMatchState(matchState) {
        if (!matchState) return;
        const red = Number(matchState?.teamScores?.[1] ?? 0);
        const blue = Number(matchState?.teamScores?.[2] ?? 0);
        const target = Number(matchState?.targetScore ?? 100);
        const progress = this._els.get('mini-match-progress');
        if (progress) {
            progress.textContent = `Red ${red} - ${blue} Blue  |  Target ${target}`;
        }
        const topRed = this._els.get('topbar-red-score');
        const topBlue = this._els.get('topbar-blue-score');
        if (topRed) topRed.textContent = `Red ${red}`;
        if (topBlue) topBlue.textContent = `Blue ${blue}`;
        this._updateTopBar(matchState);
    }

    _updateTopBar(matchState) {
        const bar = this._els.get('top-bar');
        if (!bar) return;
        const timer = bar.querySelector('#match-timer');
        if (!timer) return;
        const seconds = Math.floor(matchState.currentMatchTick / 60); // assuming 20 ticks per second
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        timer.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        const red = Number(matchState?.teamScores?.[1] ?? 0);
        const blue = Number(matchState?.teamScores?.[2] ?? 0);
        const target = Number(matchState?.targetScore ?? 100);
        if (red >= target || blue >= target) {
            timer.textContent += ' - Sudden Death!';
            timer.style.color = '#ff4444';
        } else {
            timer.style.color = '#fff';
        }
        const redScore = bar.querySelector('#topbar-red-score');
        const blueScore = bar.querySelector('#topbar-blue-score');
        if (redScore) redScore.textContent = `${red}`;
        if (blueScore) blueScore.textContent = `${blue}`;
    }

    showMatchEnd(matchState,myTeam) {
        const overlay = this._els.get('match-end-overlay');
        const title = this._els.get('match-end-title');
        const score = this._els.get('match-end-score');
        const countdown = this._els.get('match-end-countdown');
        if (!overlay || !title || !score || !countdown) return;

        const winner = this._teamMeta(Number(matchState?.winnerTeam || 0));
        const red = Number(matchState?.teamScores?.[1] ?? 0);
        const blue = Number(matchState?.teamScores?.[2] ?? 0);
        
        title.style.color = winner.color;
        if (myTeam === matchState?.winnerTeam) {
            title.textContent = winner.name === 'Neutral' ? 'MATCH ENDED' : `VICTORY!`;
        }else if (matchState?.winnerTeam !== myTeam && matchState?.winnerTeam !== 0) {
            title.textContent = `DEFEAT!`;
        }else {
            title.textContent = `MATCH ENDED`;
        }

        score.textContent = `Final: Red ${red} - ${blue} Blue`;

        overlay.style.display = 'flex';
        this._stopMatchOverlayCountdown();

        let remaining = Math.ceil((matchState?.restartInMs ?? 0) / 1000);
        countdown.textContent = remaining > 0 ? `Restarting in ${remaining}s` : 'Restarting...';
        this._matchOverlayInterval = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                countdown.textContent = 'Restarting...';
                this._stopMatchOverlayCountdown();
            } else {
                countdown.textContent = `Restarting in ${remaining}s`;
            }
        }, 1000);
    }

    hideMatchEnd() {
        this._stopMatchOverlayCountdown();
        const overlay = this._els.get('match-end-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private element factories
    // ─────────────────────────────────────────────────────────────────────────

    _mount(id, el) {
        document.body.appendChild(el);
        this._els.set(id, el);
        return el;
    }

    _createDebugOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'debug-overlay';
        overlay.style.cssText = `
            position: fixed;
            bottom: 10px;
            left: 10px;
            color: #0f0;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.2em;
            white-space: pre-line;
            z-index: 1000;
            pointer-events: none;
        `;
        overlay.textContent = 'DEBUG INFO';
        this._mount('debug-overlay', overlay);
        this._els.set('debug-overlay', overlay);
    }

    _createTopBar() {
        const bar = document.createElement('div');
        bar.id = 'top-bar';
        bar.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999;
            pointer-events: none;
        `;
        const redScore = document.createElement('div');
        redScore.id = 'topbar-red-score';
        redScore.style.cssText = `
            color: #ff5b5b;
            font-family: 'Robot Heroes', Arial, sans-serif;
            font-size: 24px;
            font-weight: bold;
            text-shadow: 2px 2px 6px black;
            z-index: 1000;
            pointer-events: none;
            padding: 10px 10px;
            margin-right: 20px;
        `;
        redScore.textContent = '0';

        bar.appendChild(redScore);
        bar.appendChild(document.createElement('div')); // spacer for centering
      
        const timer = document.createElement('div');
        timer.id = 'match-timer';
        timer.style.cssText = `
            color: #fff;
            font-family: 'Robot Heroes', Arial, sans-serif;
            font-size: 18px;
            font-weight: bold;
            text-shadow: 2px 2px 6px black;
            z-index: 1000;
            pointer-events: none;
        `;
        timer.textContent = '00:00';
        bar.appendChild(timer);
        bar.appendChild(document.createElement('div')); // spacer for centering

        const blueScore = document.createElement('div');
        blueScore.id = 'topbar-blue-score';
        blueScore.style.cssText = `
            color: #56a0ff;
            font-family: 'Robot Heroes', Arial, sans-serif;
            font-size: 24px;
            font-weight: bold;
            text-shadow: 2px 2px 6px black;
            z-index: 1000;
            pointer-events: none;
            padding: 10px 10px;
            margin-left: 20px;
        `;
        blueScore.textContent = '0';
        bar.appendChild(blueScore);
        this._mount('top-bar', bar);
    }

    _createHealthBar() {
        const bar = document.createElement('div');
        bar.id = 'health-bar';

        const fill = document.createElement('div');
        fill.id = 'health-fill';
        fill.style.cssText = `
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, #00cc00, #00ff00);
            transition: width 0.3s, background 0.3s;
        `;
        bar.appendChild(fill);

        const text = document.createElement('div');
        text.id = 'health-text';

        text.textContent = '100 HP';
        bar.appendChild(text);

        this._mount('health-bar', bar);
        this._els.set('health-fill', fill);
        this._els.set('health-text', text);
    }

    _createShieldBar() {
        const bar = document.createElement('div');
        bar.id = 'shield-bar';

        const fill = document.createElement('div');
        fill.style.cssText = `
            width: 0%;
            height: 100%;
            background: linear-gradient(90deg, #0055cc, #55aaff);
            transition: width 0.25s;
        `;
        bar.appendChild(fill);
        const text = document.createElement('div');
        text.style.cssText = `
            position:absolute; top:50%; left:50%;
            transform:translate(-50%,-50%);
            color:#cce8ff; font-family:Arial,sans-serif;
            font-weight:bold; font-size:11px;
            text-shadow:1px 1px 3px black;
        `;
        text.textContent = '0 SH';
        bar.appendChild(text);
        this._mount('shield-bar', bar);
        this._els.set('shield-fill', fill);
        this._els.set('shield-text', text);
    }

    _createArmorBar() {
        const bar = document.createElement('div');
        bar.id = 'armor-bar';

        const fill = document.createElement('div');
        fill.style.cssText = `
            width: 0%;
            height: 100%;
            background: linear-gradient(90deg, #996600, #ffcc00);
            transition: width 0.25s;
        `;
        bar.appendChild(fill);
        const text = document.createElement('div');
        text.style.cssText = `
            position:absolute; top:50%; left:50%;
            transform:translate(-50%,-50%);
            color:#fff4cc; font-family:Arial,sans-serif;
            font-weight:bold; font-size:11px;
            text-shadow:1px 1px 3px black;
        `;
        text.textContent = '0 AR';
        bar.appendChild(text);
        this._mount('armor-bar', bar);
        this._els.set('armor-fill', fill);
        this._els.set('armor-text', text);
    }

    _createAmmoCounter() {
        const el = document.createElement('div');
        el.id = 'ammo-counter';

        el.textContent = '- / -';
        this._mount('ammo-counter', el);
    }

    _createAbilityBar() {
        const bar = document.createElement('div');
        bar.id = 'ability-bar';

        const slots = [
            { id: 'ability-slot-1', key: '1' },
            { id: 'ability-slot-2', key: '2' },
            { id: 'ability-slot-3', key: '3' },
        ];

        for (const { id, key } of slots) {
            const slot = document.createElement('div');
            slot.className = 'ability-slot';

            // Cooldown darkening overlay (fills from bottom)
            const cover = document.createElement('div');
            cover.className = 'ability-cd-cover';

            slot.appendChild(cover);

            // Key label
            const label = document.createElement('span');
            label.textContent = key;
            
            slot.appendChild(label);

            bar.appendChild(slot);
            this._els.set(id, slot);
        }

        this._mount('ability-bar', bar);
    }

    _createKillMessage() {
        const el = document.createElement('div');
        el.id = 'kill-message';
        el.style.cssText = `
            position: fixed;
            text-align: center;
            top: 40%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-family: "Robot Heroes", Arial, sans-serif;
            font-size: 36px;
            font-weight: bold;
            color: #ff4500;
            text-shadow: 4px 4px 8px black;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
            z-index: 1000;
        `;
        this._mount('kill-message', el);
    }

    _createKillFeed() {
        const el = document.createElement('div');
        el.id = 'kill-feed';
        el.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            width: 300px;
            max-height: 200px;
            overflow: hidden;
            font-family: Arial, sans-serif;
            font-size: 14px;
            color: white;
            text-shadow: 2px 2px 4px black;
            z-index: 900;
        `;
        this._mount('kill-feed', el);
    }

    _createKillStreak() {
        const el = document.createElement('div');
        el.id = 'kill-streak';
        el.style.cssText = `
            position: fixed;
            top: 30%;
            left: 50%;
            transform: translate(-50%, -30%);
            font-family: "Robot Heroes", Arial, sans-serif;
            font-size: 48px;
            font-weight: bold;
            color: #ffff00;
            text-shadow: 4px 4px 8px black;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
            z-index: 1000;
        `;
        this._mount('kill-streak', el);
    }

    _createScoreboards() {
        // Mini scoreboard (always visible, top-left)
        const mini = document.createElement('div');
        mini.id = 'mini-scoreboard';
        mini.innerHTML = `
            <div class="ms-title">Top Players</div>
            <div id="mini-scoreboard-rows"></div>
        `;
        this._mount('mini-scoreboard', mini);

        // Full scoreboard (shown while Tab held)
        const sb = document.createElement('div');
        sb.id = 'scoreboard';
        sb.innerHTML = `
            <h2>Scoreboard</h2>
            <div id="scoreboard-team-totals" style="text-align:center;margin:0 0 10px 0;font-family:Arial,sans-serif;font-size:14px;"></div>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Hero</th>
                        <th>Kills</th>
                        <th>Deaths</th>
                        <th>K/D</th>
                    </tr>
                </thead>
                <tbody id="scoreboard-body"></tbody>
            </table>
        `;
        this._mount('scoreboard', sb);
        const totals = sb.querySelector('#scoreboard-team-totals');
        if (totals) this._els.set('scoreboard-team-totals', totals);
    }

    _createMatchEndOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'match-end-overlay';
        overlay.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 2600;
            pointer-events: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            font-family: Arial, sans-serif;
            color: #fff;
        `;

        const title = document.createElement('div');
        title.id = 'match-end-title';
        title.style.cssText = 'font-size:52px;font-family: "Robot Heroes", Arial, sans-serif;font-weight:bold;letter-spacing:3px;text-shadow:0 0 14px rgba(0,0,0,0.9);margin-bottom:12px;';
        title.textContent = 'MATCH ENDED';

        const score = document.createElement('div');
        score.id = 'match-end-score';
        score.style.cssText = 'font-size:24px;color:#e8e8e8;margin-bottom:10px;';
        score.textContent = 'Final: Red 0 - 0 Blue';

        const countdown = document.createElement('div');
        countdown.id = 'match-end-countdown';
        countdown.style.cssText = 'font-size:18px;color:#c8c8c8;';
        countdown.textContent = 'Restarting...';

        overlay.appendChild(title);
        overlay.appendChild(score);
        overlay.appendChild(countdown);
        this._mount('match-end-overlay', overlay);
        this._els.set('match-end-title', title);
        this._els.set('match-end-score', score);
        this._els.set('match-end-countdown', countdown);
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 4px;
            height: 4px;
            background: white;
            border: 1px solid black;
            border-radius: 50%;
            pointer-events: none;
            z-index: 1000;
        `;
        this._mount('crosshair', el);
    }

    _createHitmarker() {
        const el = document.createElement('div');
        el.id = 'hitmarker';
        el.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 20 20" style="display:block;">
                <line x1="2"  y1="2"  x2="18" y2="18" stroke="white" stroke-width="2"/>
                <line x1="18" y1="2"  x2="2"  y2="18" stroke="white" stroke-width="2"/>
            </svg>
        `;
        this._mount('hitmarker', el);
    }

    _createRespawnOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'respawn-overlay';

        const title = document.createElement('div');
        title.id = 'respawn-title';
        title.style.cssText = `
            font-family: "Robot Heroes", Arial, sans-serif;
            font-size: 52px;
            font-weight: bold;
            color: #ff4444;
            text-shadow: 0 0 20px rgba(255,0,0,0.8), 4px 4px 8px black;
            letter-spacing: 6px;
            margin-bottom: 20px;
        `;
        this._els.set('respawn-title', title);
        title.textContent = 'KILLED';

        const subtext = document.createElement('div');
        subtext.style.cssText = `
            font-family: Arial, sans-serif;
            font-size: 20px;
            color: rgba(255,255,255,0.7);
            letter-spacing: 2px;
            margin-bottom: 10px;
        `;
        subtext.textContent = 'RESPAWNING IN';

        const countdown = document.createElement('div');
        countdown.id = 'respawn-countdown';
        countdown.style.cssText = `
            font-family: Arial, sans-serif;
            font-size: 80px;
            font-weight: bold;
            color: white;
            text-shadow: 4px 4px 12px black;
            line-height: 1;
        `;
        countdown.textContent = '3';

        overlay.appendChild(title);
        overlay.appendChild(subtext);
        overlay.appendChild(countdown);

        this._mount('respawn-overlay', overlay);
        this._els.set('respawn-countdown', countdown);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    _stopRespawnCountdown() {
        if (this._respawnInterval !== null) {
            clearInterval(this._respawnInterval);
            this._respawnInterval = null;
        }
    }
    _createSelfEffectBar() {
        // Inject the pulse animation keyframes once
        if (!document.getElementById('hud-pulse-style')) {
            const st = document.createElement('style');
            st.id = 'hud-pulse-style';
            st.textContent = `
                @keyframes hud-pulse {
                    0%,100% { opacity:1; }  50% { opacity:0.55; }
                }
            `;
            document.head.appendChild(st);
        }
        const bar = document.createElement('div');
        bar.id = 'self-effect-bar';
        bar.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: center;
            z-index: 990;
            pointer-events: none;
        `;
        this._mount('self-effect-bar', bar);
    }

    _createScreenTintOverlay() {
        const el = document.createElement('div');
        el.id = 'screen-tint';
        el.style.cssText = `
            display: none;
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 880;
        `;
        const lbl = document.createElement('div');
        lbl.className = 'screen-tint-label';
        lbl.style.cssText = `
            position: absolute;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 22px;
            font-weight: bold;
            letter-spacing: 3px;
            text-transform: uppercase;
            color: rgba(255,255,255,0.8);
            text-shadow: 0 0 14px currentColor;
            pointer-events: none;
        `;
        el.appendChild(lbl);
        this._mount('screen-tint', el);
    }

    _stopMatchOverlayCountdown() {
        if (this._matchOverlayInterval !== null) {
            clearInterval(this._matchOverlayInterval);
            this._matchOverlayInterval = null;
        }
    }
}
