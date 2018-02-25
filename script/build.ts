/* tslint:disable:no-sync-functions */
/* eslint-disable no-sync */
/// <reference path="./globals.d.ts" />

import * as path from 'path'
import * as cp from 'child_process'
import * as fs from 'fs-extra'
import * as packager from 'electron-packager'

const legalEagle: LegalEagle = require('legal-eagle')

import { getBundleID, getProductName, getVersion } from '../app/package-info'

import { getReleaseChannel, getDistRoot, getExecutableName } from './dist-info'

const projectRoot = path.join(__dirname, '..')
const outRoot = path.join(projectRoot, 'out')

const isPublishableBuild = getReleaseChannel() !== 'development'

console.log(`Building for ${getReleaseChannel()}…`)

console.log('Removing old distribution…')
fs.removeSync(getDistRoot())

console.log('Copying dependencies…')
copyDependencies()

console.log('Packaging emoji…')
copyEmoji()

console.log('Copying static resources…')
copyStaticResources()

const isFork = process.env.CIRCLE_PR_USERNAME
if (
  process.env.CIRCLE_BUILD_IMAGE &&
  process.env.CIRCLE_BUILD_IMAGE === 'osx' &&
  !isFork
) {
  console.log('Setting up keychain…')
  cp.execSync(path.join(__dirname, 'setup-macos-keychain'))
}

console.log('Updating our licenses dump…')
updateLicenseDump(err => {
  if (err) {
    console.error(
      'Error updating the license dump. This is fatal for a published build.'
    )
    console.error(err)

    if (isPublishableBuild) {
      process.exit(1)
    }
  }

  console.log('Packaging…')
  packageApp((err, appPaths) => {
    if (err) {
      console.error(err)
      process.exit(1)
    } else {
      console.log(`Built to ${appPaths}`)
    }
  })
})

/**
 * The additional packager options not included in the existing typing.
 *
 * See https://github.com/desktop/desktop/issues/2429 for some history on this.
 */
interface IPackageAdditionalOptions {
  readonly protocols: ReadonlyArray<{
    readonly name: string
    readonly schemes: ReadonlyArray<string>
  }>
}

function packageApp(
  callback: (error: Error | null, appPaths: string | string[]) => void
) {
  // not sure if this is needed anywhere, so I'm just going to inline it here
  // for now and see what the future brings...
  const toPackagePlatform = (platform: NodeJS.Platform) => {
    if (platform === 'darwin') {
      return platform
    }
    throw new Error(
      `Unable to convert to platform for electron-packager: '${
        process.platform
      }`
    )
  }

  const options: packager.Options & IPackageAdditionalOptions = {
    name: getExecutableName(),
    platform: toPackagePlatform(process.platform),
    arch: 'x64',
    asar: false, // TODO: Probably wanna enable this down the road.
    out: getDistRoot(),
    icon: path.join(projectRoot, 'app', 'static', 'logos', 'icon-logo'),
    dir: outRoot,
    overwrite: true,
    tmpdir: false,
    derefSymlinks: false,
    prune: false, // We'll prune them ourselves below.
    ignore: [
      new RegExp('/node_modules/electron($|/)'),
      new RegExp('/node_modules/electron-packager($|/)'),
      new RegExp('/\\.git($|/)'),
      new RegExp('/node_modules/\\.bin($|/)'),
    ],
    appCopyright: 'Copyright © 2017 Mathieu Dutour.',

    // macOS
    appBundleId: getBundleID(),
    appCategoryType: 'public.app-category.developer-tools',
    osxSign: true,
    protocols: [
      {
        name: getBundleID(),
        schemes: [
          isPublishableBuild ? 'x-kactus-auth' : 'x-kactus-dev-auth',
          'x-kactus-client',
          'x-github-client',
          'github-mac',
          'kactus',
        ],
      },
    ],
  }

  packager(options, (err: Error, appPaths: string | string[]) => {
    if (err) {
      callback(err, appPaths)
    } else {
      callback(null, appPaths)
    }
  })
}

function removeAndCopy(source: string, destination: string) {
  fs.removeSync(destination)
  fs.copySync(source, destination)
}

function copyEmoji() {
  const emojiImages = path.join(projectRoot, 'gemoji', 'images', 'emoji')
  const emojiImagesDestination = path.join(outRoot, 'emoji')
  removeAndCopy(emojiImages, emojiImagesDestination)

  const emojiJSON = path.join(projectRoot, 'gemoji', 'db', 'emoji.json')
  const emojiJSONDestination = path.join(outRoot, 'emoji.json')
  removeAndCopy(emojiJSON, emojiJSONDestination)
}

function copyStaticResources() {
  const dirName = process.platform
  const platformSpecific = path.join(projectRoot, 'app', 'static', dirName)
  const common = path.join(projectRoot, 'app', 'static', 'common')
  const destination = path.join(outRoot, 'static')
  fs.removeSync(destination)
  if (fs.existsSync(platformSpecific)) {
    fs.copySync(platformSpecific, destination)
  }
  fs.copySync(common, destination, { clobber: false })
}

function copyDependencies() {
  // eslint-disable-next-line import/no-dynamic-require
  const originalPackage: Package = require(path.join(
    projectRoot,
    'app',
    'package.json'
  ))

  // eslint-disable-next-line import/no-dynamic-require
  const commonConfig = require(path.resolve(__dirname, '../app/webpack.common'))
  const externals = commonConfig.externals
  const oldDependencies = originalPackage.dependencies
  const newDependencies: PackageLookup = {}

  for (const name of Object.keys(oldDependencies)) {
    const spec = oldDependencies[name]
    if (externals.indexOf(name) !== -1) {
      newDependencies[name] = spec
    }
  }

  const oldDevDependencies = originalPackage.devDependencies
  const newDevDependencies: PackageLookup = {}

  if (!isPublishableBuild) {
    for (const name of Object.keys(oldDevDependencies)) {
      const spec = oldDevDependencies[name]
      if (externals.indexOf(name) !== -1) {
        newDevDependencies[name] = spec
      }
    }
  }

  // The product name changes depending on whether it's a prod build or dev
  // build, so that we can have them running side by side.
  const updatedPackage = Object.assign({}, originalPackage, {
    productName: getProductName(),
    dependencies: newDependencies,
    devDependencies: newDevDependencies,
  })

  if (isPublishableBuild) {
    delete updatedPackage.devDependencies
  }

  fs.writeFileSync(
    path.join(outRoot, 'package.json'),
    JSON.stringify(updatedPackage)
  )

  fs.removeSync(path.resolve(outRoot, 'node_modules'))

  if (
    Object.keys(newDependencies).length ||
    Object.keys(newDevDependencies).length
  ) {
    console.log('  Installing dependencies via npm…')
    cp.execSync('npm install', { cwd: outRoot, env: process.env })
  }

  if (!isPublishableBuild) {
    console.log(
      '  Installing 7zip (dependency for electron-devtools-installer)'
    )

    const sevenZipSource = path.resolve(projectRoot, 'app/node_modules/7zip')
    const sevenZipDestination = path.resolve(outRoot, 'node_modules/7zip')

    fs.mkdirpSync(sevenZipDestination)
    fs.copySync(sevenZipSource, sevenZipDestination)
  }

  console.log('  Copying git environment…')
  const gitDir = path.resolve(outRoot, 'git')
  fs.removeSync(gitDir)
  fs.mkdirpSync(gitDir)
  fs.copySync(path.resolve(projectRoot, 'app/node_modules/dugite/git'), gitDir)

  console.log('  Copying app-path binary…')
  const appPathMain = path.resolve(outRoot, 'main')
  fs.removeSync(appPathMain)
  fs.copySync(
    path.resolve(projectRoot, 'app/node_modules/app-path/main'),
    appPathMain
  )
}

function updateLicenseDump(callback: (err: Error | null) => void) {
  const appRoot = path.join(projectRoot, 'app')
  const outPath = path.join(outRoot, 'static', 'licenses.json')
  const licenseOverrides: LicenseLookup = require('./license-overrides')

  legalEagle(
    { path: appRoot, overrides: licenseOverrides, omitPermissive: true },
    (err, summary) => {
      if (err) {
        callback(err)
        return
      }

      if (Object.keys(summary).length > 0) {
        const overridesPath = path.join(__dirname, 'license-overrides.js')
        let licensesMessage = ''
        for (const key in summary) {
          const license = summary[key]
          licensesMessage += `${key} (${license.repository}): ${
            license.license
          }\n`
        }

        const message = `The following dependencies have unknown or non-permissive licenses. Check it out and update ${overridesPath} if appropriate:\n${licensesMessage}`
        callback(new Error(message))
      } else {
        legalEagle(
          { path: appRoot, overrides: licenseOverrides },
          (err, summary) => {
            if (err) {
              callback(err)
              return
            }

            // legal-eagle still chooses to ignore the LICENSE at the root
            // this injects the current license and pins the source URL before we
            // dump the JSON file to disk
            const licenseSource = path.join(projectRoot, 'LICENSE')
            const licenseText = fs.readFileSync(licenseSource, {
              encoding: 'utf-8',
            })
            const appVersion = getVersion()

            summary[`kactus@${appVersion}`] = {
              repository: 'https://github.com/kactus-io/kactus',
              license: 'MIT',
              source: `https://github.com/kactus-io/kactus/blob/release-${appVersion}/LICENSE`,
              sourceText: licenseText,
            }

            // inject the desktop/desktop LICENSE from which we forked
            summary[`desktop@0.6.5`] = {
              repository: 'https://github.com/desktop/desktop',
              license: 'MIT',
              source: `https://github.com/desktop/desktop/blob/master/LICENSE`,
              sourceText: `Copyright (c) GitHub, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
            }

            fs.writeFileSync(outPath, JSON.stringify(summary), {
              encoding: 'utf8',
            })
            callback(null)
          }
        )
      }
    }
  )
}
