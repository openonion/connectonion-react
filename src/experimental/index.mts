/** Native-capable package root for modern ESM/browser consumers. */
import { registerNativeACPDriver } from '../connect/native-acp-runtime.js';
import { officialNativeACPDriver } from './native-acp.mjs';

registerNativeACPDriver(officialNativeACPDriver);

export * from '../index.js';
