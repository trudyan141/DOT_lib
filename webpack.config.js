const path = require('path');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'signDot.js',
    path: path.resolve(__dirname, 'dist'),
  },
};