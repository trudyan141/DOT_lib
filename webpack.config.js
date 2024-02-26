const path = require('path');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'dotLib.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'dotLib',
    libraryTarget: 'umd',
    globalObject: 'this',
  },
};