# SICARIO SH — Bots Discord

Projet Node.js qui regroupe le bot support/commandes et le bot générateur.

## Installation locale ou sur VPS

Prérequis : Node.js 18 ou supérieur.

```bash
cd sicario-sh-bot
npm install
cp .env.example .env
nano .env
npm start
```

`npm start` lance les deux bots et reste compatible avec un VPS Linux.

Pour lancer un seul bot :

```bash
npm run start:bot1
npm run start:bot2
```

## Configuration

Renseigner au minimum `BOT1_TOKEN` et `BOT2_TOKEN` dans `.env`.
Pour activer la sauvegarde distante, renseigner aussi `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY`, puis exécuter une fois le contenu de
`supabase/schema.sql` dans l’éditeur SQL Supabase. Au premier démarrage, les
fichiers locaux sont envoyés dans Supabase s’il n’existe encore aucune donnée
distante. Les démarrages suivants récupèrent la version la plus récente.
Tu peux vérifier la configuration avec `npm run db:check` après avoir créé la
table. Si Supabase est temporairement indisponible, le bot continue avec les
fichiers locaux et réessaie au prochain redémarrage.
Les identifiants Discord et les réglages métier existants restent dans
`src/config/defaultConfig.js` et peuvent être modifiés depuis le panel
administrateur lorsque la fonction est disponible.

Les dossiers `data/` et `stock/` contiennent les données persistantes du bot.
Ils doivent être sauvegardés avant toute mise à jour ou migration du VPS.
Ne jamais publier `.env`, `data/access.json` ou les fichiers de `stock/`.

## Statistiques des avis

`!avis` recalcule les avis en parcourant l’historique Discord des salons +rep
et photos. `!avis-sync`, réservé aux administrateurs, recalcule puis enregistre
les messages avec leur ID unique dans le journal local. Pour synchroniser aussi
la table Supabase `review_messages`, exécuter la dernière version de
`supabase/schema.sql` dans l’éditeur SQL Supabase.

## Déploiement avec systemd

Créer un service qui lance `npm start` depuis ce dossier, puis activer le
redémarrage automatique. Exemple :

```ini
[Unit]
Description=SICARIO SH Discord Bots
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sicario-sh-bot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Après installation du service :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sicario-sh
sudo journalctl -u sicario-sh -f
```

## Commandes pratiques ajoutées

- `!status` — état du Bot 1, commandes en attente et statut Supabase, réservé aux administrateurs
- `.access` ou `.acces` — vérifier son propre accès générateur
- `.stock <service>` — consulter uniquement un stock précis

## Sauvegardes

Avant une modification importante, sauvegarder au minimum `data/` et `stock/`.
Les écritures JSON principales sont atomiques et conservent une sauvegarde `.bak`.