// Сборка лаунчера без Node.js и npm — через Electron в режиме Node:
//   ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 node_modules/electron/dist/electron.exe tools/dist.js
// Результат в dist/: Setup, .blockmap, latest.yml, Portable.
'use strict';
process.noAsar = true; // иначе Electron считает app.asar папкой и не может её удалить
process.chdir(require('path').join(__dirname, '..'));

// electron-builder ищет зависимости через `npm list`. У лаунчера нет зависимостей для упаковки
// (только devDependencies), поэтому без npm просто говорим, что копировать из node_modules нечего.
const pkg = require('../package.json');
if (Object.keys(pkg.dependencies || {}).length) throw new Error('В package.json появились dependencies — собирайте через npm run dist');
const copier = require('app-builder-lib/out/util/appFileCopier');
copier.computeNodeModuleFileSets = async () => [];

const builder = require('electron-builder');
builder
  .build({ targets: builder.Platform.WINDOWS.createTarget(), publish: 'never' })
  .then((files) => console.log(`Готово:\n${files.join('\n')}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
