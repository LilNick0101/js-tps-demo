/**
 * HeroSelect – full-screen overlay for choosing a hero before (re)spawning.
 *
 * Usage:
 *   const heroSelect = new HeroSelect(document.body);
 *   heroSelect.show((heroClass) => {
 *       channel.emit('setHero', { heroClass });
 *   });
 *   // hide it from the outside via heroSelect.hide() when 'heroSet' ack arrives
 */

const HERO_DATA = [
    {
        id: 0,
        name: 'Dummy',
        role: 'Test · Assault Rifle',
        color: '#888',
        desc: 'A blank canvas for testing. No special abilities.',
        abilities: [
            { key: 'Q', name: '—', desc: 'No ability' },
            { key: 'E', name: '—', desc: 'No ability' },
            { key: 'Z', name: '—', desc: 'No ability' },
        ],
    },
    {
        id: 1,
        name: 'Sven',
        role: 'DPS · SMG',
        color: '#9933ff',
        desc: 'Shadow alien wizard that is also a close quarters menace!',
        abilities: [
            { key: 'Q', name: 'Shadow Lightning', desc: 'Call down 3 lightning strikes in a line ahead of you.' },
            { key: 'E', name: 'Shadow Teleport', desc: 'Dash 5 m forward instantly.' },
            { key: 'Z', name: 'Shadow Storm', desc: 'Summon a lasting AOE storm that damages all nearby enemies.' },
        ],
    },
    {
        id: 2,
        name: 'Tamerlane',
        role: 'Tank · Shotgun',
        color: '#f5c542',
        desc: 'Vigilante bruiser who uses high-impact gadgets to control the battlefield.',
        abilities: [
            { key: '1', name: 'Shock Grenade', desc: 'Throw a grenade that explodes and slows all caught in the blast.' },
            { key: '2', name: 'Willpower', desc: 'Activate a personal energy shield that absorbs incoming damage lasting 5 s.' },
            { key: '3', name: 'Cluster Strike', desc: 'Call in a cluster-bomb barrage that blankets a wide area.' },
        ],
    },
    {
        id: 3,
        name: 'Father Callas',
        role: 'Tank · Pump Shotgun',
        color: '#c471ed',
        desc: '"Naive men pray to the gods, they will learn to pray to me." — An evil tank priest who steals life, shrugs off punishment, and exiles enemies to another dimension.',
        abilities: [
            { key: '1', name: 'Siphon Life', desc: 'Channel for 6 seconds, continuously draining all enemies in an 80° cone ahead and healing yourself for 30% of damage dealt.' },
            { key: '2', name: 'Iron Stand', desc: 'Become invulnerable and frozen for a brief moment. Afterwards, 20% of all incoming damage converts to shield for 10 s.' },
            { key: '3', name: 'Shadow Realm Banish', desc: 'Exile the nearest enemy for 6 s — immune but unable to act. They take damage on return.' },
        ],
    },
    {
        id: 4,
        name: 'Selene',
        role: 'DPS · Machine Pistol',
        color: '#a8e6cf',
        desc: 'Moon-girl assassin. Higher base movement speed but lower health. Dashes through enemies, flies above the fray, and silences entire squads with a lunar blast.',
        abilities: [
            { key: '1', name: 'Crystal Smash', desc: 'Dash forward and collide with an enemy, dealing damage and stunning them for 1 s. A kill drops a crystal shard that restores 20 HP.' },
            { key: '2', name: 'Astral Elevation', desc: 'Launch into the air and become untargetable for 3 s, flying. After landing, gain +50 % weapon damage for 3 s.' },
            { key: '3', name: 'Lunar Eclipse', desc: 'Leap skyward, then detonate 3 lunar blasts, each dealing 60 damage and 4 s silence to all enemies in a large radius.' },
        ],
    },
    {
        id: 5,
        name: 'Fat Jerome',
        role: 'Tank · Shotgun',
        color: '#39901a',
        desc: 'A stinky and greedy comic relief villain with a big belly and a love for garbage food and money.',
        abilities: [
            { key: '1', name: 'Shoulder Charge', desc: 'Charge forward for 1.5 s, knocking back and damaging enemies in your path. Can steer left and right while charging.' },
            { key: '2', name: 'Butt Smash', desc: 'Jump into the air and slam down, dealing damage in a small area. Enemies right next to you take more damage and are stunned briefly.' },
            { key: '3', name: 'Fatal Flatulence', desc: 'Start farting every second releasing a lingering fart cloud that deals non-lethal damage and slows enemies. Lasts 10 seconds.' },
        ],
    },
    {
        id: 6,
        name: 'Kyoukan',
        role: 'Support · Sniper Rifle',
        color: '#63d1ff',
        desc: 'Backline sniper support that keeps allies alive and enables team ult tempo.',
        abilities: [
            { key: '1', name: 'Arrow of Gratitude', desc: 'Heal the closest ally in front of you for 20% max HP. Hold middle mouse to self-cast.' },
            { key: '2', name: 'Majestic Leap', desc: 'Perform a huge directional leap upward at high speed.' },
            { key: '3', name: 'Heroic Aura', desc: 'For 10 s, every second grant armor and reduce ultimate cooldown for yourself and nearby allies.' },
        ],
    },
    {
        id: 7,
        name: 'Templar',
        role: 'Support · Assault Rifle',
        color: '#18d049',
        desc: 'Holy knight support who can heal allies and punish enemies with a powerful smite. A versatile pick for players who like to adapt to their team\'s needs.',
        abilities: [
            { key: '1', name: 'Holy Water', desc: 'Throw a flask of holy water that shatters on impact, healing allies and damaging enemies in an area.' },
            { key: '2', name: 'Healing Rite', desc: 'Channel for 6 seconds, continuously healing all allies in an 80° cone ahead and restoring 30% of damage dealt to yourself.' },
            { key: '3', name: 'Hammer of Justice', desc: 'Strike a hammer on the ground, creating a shockwave that damages enemies and stuns them for 3 seconds.' },
        ]
    }
];

class HeroSelect {
    /**
     * @param {HTMLElement} container  - element to mount the overlay into
     */
    constructor(container) {
        this.container = container;
        this._overlay  = null;
        this._callback = null;
        this._build();
    }

    _build() {
        const overlay = document.createElement('div');
        overlay.id = 'hero-select-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.85);
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            z-index: 9999;
            font-family: 'Segoe UI', sans-serif;
        `;

        const title = document.createElement('h1');
        title.textContent = 'Choose Your Hero';
        title.style.cssText = 'color:#fff; font-size:2rem; margin-bottom:32px; letter-spacing:2px; font-family: "Robot Heroes", Arial, sans-serif;';
        overlay.appendChild(title);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:24px; flex-wrap:wrap; justify-content:center;';
        overlay.appendChild(row);

        for (const hero of HERO_DATA) {
            row.appendChild(this._buildCard(hero));
        }

        this._overlay = overlay;
    }

    _buildCard(hero) {
        const card = document.createElement('div');
        card.style.cssText = `
            background: rgba(255,255,255,0.05);
            border: 2px solid ${hero.color}44;
            border-radius: 12px;
            padding: 24px 20px;
            width: 220px;
            cursor: pointer;
            transition: border-color 0.2s, transform 0.15s, background 0.2s;
            color: #eee;
            user-select: none;
        `;

        card.addEventListener('mouseenter', () => {
            card.style.borderColor = hero.color;
            card.style.background  = `rgba(255,255,255,0.10)`;
            card.style.transform   = 'translateY(-4px)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.borderColor = `${hero.color}44`;
            card.style.background  = 'rgba(255,255,255,0.05)';
            card.style.transform   = 'none';
        });

        card.innerHTML = `
            <div style="font-size:1.5rem; font-weight:700; color:${hero.color}; margin-bottom:4px; font-family: 'Robot Heroes', Arial, sans-serif;">${hero.name}</div>
            <div style="font-size:0.78rem; color:#aaa; margin-bottom:12px;">${hero.role}</div>
            <div style="font-size:0.85rem; margin-bottom:16px; line-height:1.4;">${hero.desc}</div>
            ${hero.abilities.map(a => `
                <div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:8px;">
                    <span style="
                        font-size:0.72rem; font-weight:700;
                        background:${hero.color}22; border:1px solid ${hero.color}88;
                        border-radius:4px; padding:2px 6px; color:${hero.color};
                        flex-shrink:0; margin-top:1px;
                    ">[${a.key}]</span>
                    <div>
                        <div style="font-size:0.82rem; font-weight:600;">${a.name}</div>
                        <div style="font-size:0.75rem; color:#aaa; margin-top:1px;">${a.desc}</div>
                    </div>
                </div>
            `).join('')}
        `;

        card.addEventListener('click', () => this._select(hero.id));
        return card;
    }

    _select(heroId) {
        if (this._callback) {
            this._callback(heroId);
        }
    }

    /**
     * Display the overlay. Calls `cb(heroClassId)` when the player picks a hero.
     * @param {(heroClassId: number) => void} cb
     */
    show(cb) {
        this._callback = cb;
        if (!this._overlay.parentNode) {
            this.container.appendChild(this._overlay);
        }
        this._overlay.style.display = 'flex';
    }

    /** Hide (but don't destroy) the overlay. */
    hide() {
        if (this._overlay) {
            this._overlay.style.display = 'none';
        }
    }
}

export default HeroSelect;
