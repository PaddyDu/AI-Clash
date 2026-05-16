// Runs after electron-builder packages the .app, before code signing.
//
// macOS Sequoia/Tahoe adds com.apple.FinderInfo / com.apple.fileprovider.fpfs#P
// extended attributes to nested .app bundles during the packaging step.
// codesign refuses these with "resource fork, Finder information, or similar
// detritus not allowed". We strip them here so signing can proceed.
//
// `xattr -cr` on the parent doesn't reliably descend into nested .app dirs,
// so we explicitly iterate every directory under the output and clear xattrs
// on each one. The SIP-protected com.apple.provenance remains but is tolerated
// by codesign.
const {execFileSync} = require('child_process');

function clearAll(root) {
    // Use shell find so we touch every entry, including bundle dirs and files
    // under them. The -name patterns ensure we hit every level.
    try {
        execFileSync('bash', ['-c',
            `find "${root}" \\( -type d -o -type f \\) -exec xattr -c {} + 2>/dev/null; true`
        ], {stdio: 'inherit'});
    } catch (e) {
        console.warn(`[afterPack] find/xattr failed (continuing): ${e.message}`);
    }
}

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const appOutDir = context.appOutDir;
    clearAll(appOutDir);
    console.log(`[afterPack] cleared xattrs throughout ${appOutDir}`);
};
