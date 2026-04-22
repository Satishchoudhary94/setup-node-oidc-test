'use strict';

/**
 * A simple hello function to make this a valid npm package.
 * This package exists solely to demonstrate the setup-node OIDC issue.
 */
function hello(name = 'world') {
  return `Hello, ${name}!`;
}

module.exports = { hello };
