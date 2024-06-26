/*
 * This script takes JSON schema files and produces:
 * - Typescript types (types-d.ts)
 * - Validator functions (validators.mjs and validators.d.mts)
 * - Type guard functions (typeGuards.ts)
 */

import fs from 'fs';
import path from 'path';
import {execSync} from 'child_process';

import {globSync} from 'glob';
// eslint-disable-next-line import/extensions
import standAlone from 'ajv/dist/standalone/index.js';
import ajvModule from 'ajv';
import {compileFromFile} from 'json-schema-to-typescript';

const Ajv = ajvModule.default;

// set source JSON Schema files
const sourceGlobPattern = './src/schemas/**/*.schema.json';
// set output directory for the built typescript files
const outputDir = './src/schemas/auto-build';

// ensure the output directory exists
mkdir(outputDir);

// create files list
const files = globSync(sourceGlobPattern);

buildDtsFiles(files);
buildValidatorFile(files);
buildTypeGuards(files);

/**
 * Compiles a *-d.ts file from each json schema in the supplied list
 * Also creates the 'types-d.ts' entry point file which exports all of the types created
 * Deliberately produces .ts files as opposed to .d.ts files so that they can be imported
 * @param files - string array contains the list of JSON Schema files to build from
 */
function buildDtsFiles(files: string[]) {
  let typesDTS = '';
  let typesDTSFilePath = '';
  const options = {
    unreachableDefinitions: true,
    bannerComment: '/* eslint-disable */\n/**\n* This file was automatically generated by buildDtsFiles in the build-dts-and-validators script.\n* DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,\n* and run `npm run build` to regenerate this file.\n*/',
  };
  for (const filePath of files) {
    const parsed = path.parse(filePath);
    const dtsFileName = `${parsed.name.split('.')[0]}-d.ts`;
    typesDTSFilePath = path.resolve(outputDir, 'types-d.ts');

    compileFromFile(filePath, options)
      .then((ts) => fs.writeFileSync(path.resolve(outputDir, dtsFileName), ts))
      .catch((err) => {
        // we just let the error go - this is a build time script only
        throw err;
      });
    typesDTS += `export * from './${dtsFileName.replace('-d.ts', '-d.js')}';\n`;
  }
  // write the 'types-d.ts' file that we've built
  fs.writeFileSync(typesDTSFilePath, typesDTS);
}

/**
 * Uses AJV to create a Validator function for each JSON Schema supplied.
 * Each function is contained within validators.mjs file, and also has Types in
 * the validators.d.mts file
 *
 * @param files - string array contains the list of JSON Schema files to build from
 */
function buildValidatorFile(files: string[]) {
  const schemas: any[] = [];
  for (const filePath of files) {
    // read each schema, parse it and add to the schemas array
    // no error handling here - if file not present just let this error - it's only part of the build process
    const schema = JSON.parse(fs.readFileSync(filePath, {encoding: 'utf-8'}));
    // replace the $id to a name which is valid as an ESM export
    schema.$id = schema.title.replaceAll(' ', '');
    schemas.push(schema);
  }

  /* Create the AJV validation code in ESM format from the JSON Schema files */
  const ajv = new Ajv({schemas, code: {source: true, esm: true}});
  const moduleCode =
`/* This code is auto generated by ajv. We don't attempt to do full coverage testing on this code */
/* c8 ignore next */
${standAlone.default(ajv)}`;

  const outputFilePath = path.resolve(outputDir, 'validators.mjs');
  fs.writeFileSync(outputFilePath, moduleCode);

  /* Create TypeScript typings for the generated AJV validation code */
  execSync(`npx tsc -allowJs --declaration --emitDeclarationOnly "${outputFilePath}" --outDir "${outputDir}"`);
  // unfortunately tsc doesn't pick up the error part so we need to modify the created type declarations
  const typesFilePath = path.resolve(outputDir, 'validators.d.mts');
  let types = fs.readFileSync(typesFilePath, {encoding: 'utf-8'});
  types = types.replace(/(export function )([a-zA-Z0-9_]*)(\([a-zA-Z0-9{},?:;_ \r\n]*\): boolean;)/g, 'export const $2: {$3 errors: any[]}\n');
  fs.writeFileSync(typesFilePath, types);
}

/**
 * Produces typeGuards.ts file which contains a type guard function for each JSON
 * Schema supplied. It uses (imports) the validator functions made by buildValidatorFile
 * function AND the Dts files creates by buildDtsFiles function
 * @param files - string array contains the list of JSON Schema files to build from
 */
function buildTypeGuards(files: string[]) {
  let typeGuardsCode = '';
  let imports =
`/*
 * This code is auto generated by the buildTypeGuards function.
 * Do not edit manually.
 */
import * as validator from './validators.mjs';\n`;

  for (const filePath of files) {
    const parsed = path.parse(filePath);
    const dtsFileName = `${parsed.name.split('.')[0]}-d.ts`;
    const schema = JSON.parse(fs.readFileSync(filePath, {encoding: 'utf-8'}));
    const titleArr = schema.title.split(' ');
    const name = titleArr.slice(0, -1).join('');
    const ver = titleArr[titleArr.length - 1];

    typeGuardsCode += `is${name}: {

      /**
       * TS type guard function for Ortac${name}Object${ver}
       * @param json - json to be checked
       * @returns boolean
       *
       * @example
       * \`\`\`ts
       * import * as ortac from '@ortac/specification';
       *
       * const someJson: any = {random: 'value'};
       * if (ortac.typeGuards.is${name}.${ver}(someJson)) {
       *   // work with known json in ${name} format
       * }
       * \`\`\`
       */
      ${ver}: (json: any): json is ${name}Types.${name}${ver} => {
        return validator.${name}${ver}(json);
      },
    },
    `;
    imports += `import * as ${name}Types from './${dtsFileName.replace('.ts', '.js')}';\n`;
  }
  imports += `
export const typeGuards = {
  ${typeGuardsCode}
}
`;
  fs.writeFileSync('./src/schemas/auto-build/type-guards.ts', imports);
}

function mkdir(path: string) {
  try {
    fs.mkdirSync(path);
  } catch (err) {
    // allow error EEXIST (directory already exists) only
    if (typeof err !== 'object' || err === null || (err as any).code !== 'EEXIST') {
      throw err;
    }
  }
}
