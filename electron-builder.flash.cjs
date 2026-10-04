const base = require('./package.json').build
module.exports = {
  ...base,
  appId: 'com.weport.flash', productName: 'WeportFlash',
  extraMetadata: { main: 'dist-electron/flashMain.js' },
  directories: { output: 'release/flash' },
  publish: null,
  win: { ...base.win, target: ['portable'], artifactName: 'WeportFlash-${version}.${ext}' },
  portable: { artifactName: 'WeportFlash-${version}.${ext}' },
}
