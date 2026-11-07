# VintedPro

Outil de recherche de bonnes affaires Vinted, pensé **téléphone d'abord** : vraies annonces, analyse de marché, assistant IA (Gemini), favoris, stock et suivi des ventes.

> Aucune annonce n'est inventée. Sans source d'annonces configurée, le site l'indique et n'affiche rien.
> Les prix de revente sont des **estimations** (annonces comparables encore en ligne), pas des ventes réalisées.

## Détecteur autonome (fonction principale)
Le serveur balaie Vinted **tout seul** (par défaut toutes les 60 min, 3 marques par balayage, parmi la liste `SCAN_QUERIES`). Pour chaque annonce récupérée il calcule le marché à partir des annonces comparables, garde celles qui dépassent les seuils (`SCAN_MIN_PROFIT`, `SCAN_MIN_SCORE`), écarte celles à demande faible mesurée, puis demande un avis à Gemini (qui ne peut citer que des annonces réellement trouvées). Tu ouvres le site : les pépites sont déjà là, marquées « Nouveau » depuis ta dernière visite. Le chat reste disponible, replié, sous la liste.

Limites à connaître :
- **Il faut que le serveur tourne.** Un hébergement gratuit qui s'endort (Render gratuit) ne balaie pas pendant son sommeil, et peut perdre `data/feed.json` à chaque redéploiement. Pour un vrai balayage continu : hébergement toujours actif (offre payante, ou un petit serveur/Raspberry) avec un disque persistant (`DATA_DIR`).
- **Pas de notification push** : les nouveautés apparaissent à l'ouverture du site (pastille sur « Pépites »).
- **Disponibilité** : Vinted ne propose pas de vérification officielle. Une annonce qui n'apparaît plus dans les résultats est marquée « À vérifier » puis retirée après plusieurs balayages ; ce n'est pas une preuve qu'elle est vendue.
- **Demande** : indice fondé sur les favoris des annonces comparables (si ta source les fournit), pas un volume de ventes. Vinted n'expose pas les ventes conclues : aucun « prix vendu » n'est affiché.
- Chaque balayage consomme ta source d'annonces (Apify est payant à l'usage) : ajuste `SCAN_INTERVAL_MINUTES` et `SCAN_BATCH`.

## Pourquoi « Serveur non joignable / ouvert comme un simple fichier » ?
Le site a besoin de son serveur (qui garde tes clés secrètes et interroge l'IA). Il ne faut **pas** double-cliquer `public/index.html` : lance le serveur, puis ouvre l'adresse affichée.

## Démarrage sur PC (Windows)
1. Installe Node.js (version LTS) : https://nodejs.org
2. Double-clique `start.bat`. Au premier lancement un fichier `.env` s'ouvre : colle ta clé après `GEMINI_API_KEY=`
   (clé gratuite : https://aistudio.google.com/apikey), enregistre, relance `start.bat`.
3. Configure la **source d'annonces** (voir plus bas), sinon seule l'interface s'affiche.

## Utiliser le téléphone
**Option 1 — même Wi-Fi que le PC** : double-clique `start-telephone.bat`. Il affiche une adresse « Téléphone » et un jeton. Ouvre l'adresse sur le téléphone, saisis le jeton une fois. Le PC doit rester allumé.

**Option 2 — sans PC (recommandé)** : héberge le serveur dans le cloud une seule fois, ensuite tout se fait depuis le téléphone.
- Mets le dossier sur GitHub (le `.env` n'est pas envoyé : voir `.gitignore`), puis sur https://render.com → *New → Blueprint* : `render.yaml` est lu automatiquement.
- Dans Render → Environment, colle `GEMINI_API_KEY`, `APIFY_TOKEN`, `APIFY_ACTOR_ID`, `APIFY_INPUT_TEMPLATE`. Lis la valeur générée de `APP_ACCESS_TOKEN`.
- Ouvre l'adresse `https://…onrender.com` sur le téléphone, saisis le jeton, puis « Ajouter à l'écran d'accueil ».
- L'offre gratuite s'endort après inactivité : la première ouverture peut prendre ~30 s.
- La dictée vocale (micro) ne fonctionne qu'en HTTPS (donc en mode cloud) et selon le navigateur.

Les favoris, le stock et l'historique sont enregistrés **dans le navigateur du téléphone** : utilise Paramètres → export pour les sauvegarder.

## Source d'annonces
Vinted n'a pas d'API publique officielle. Deux fournisseurs sont prévus (voir `.env.example`) : `apify` (acteur Vinted de ton choix) ou `generic` (endpoint JSON). Les annonces sans titre, prix valide ou lien Vinted sont rejetées.

## Fonctionnement
- L'IA (Gemini) lance de vraies recherches, mais ne renvoie que des identifiants : le serveur ne garde que ceux réellement récupérés.
- Les chiffres (médiane, coûts, bénéfice, score) sont calculés par le code (`server/analysis.js`), jamais par l'IA.
- Les recherches IA (30–90 s) tournent en tâche de fond sur le serveur : verrouiller le téléphone ne les coupe pas.

## Développement
- Tests : `npm test` (35 tests, aucun paquet à installer).
- Styles : `public/app.css` est compilé avec Tailwind (CLI autonome) : `tailwindcss -c tailwind.config.js -i styles/input.css -o public/app.css --minify`.
- Non vérifié contre les vrais services : le modèle Gemini par défaut (`GEMINI_MODEL`, à changer si « modèle introuvable ») et le fournisseur d'annonces réel.
