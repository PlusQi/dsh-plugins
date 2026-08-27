/**
 * dsh-plugins node half. Pure UI pack: the empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; every browser plugin ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. Each cordis.patch.yml row is one host fiber whose
 * config.plugin names the pack plugin (presence / disable anchor today; a
 * future pack plugin needing host-side code would dispatch on it here).
 * The client half is a per-package singleton that registers ALL plugins'
 * UI unconditionally - see lib/client.js.
 */
function apply() {}
export { apply };
