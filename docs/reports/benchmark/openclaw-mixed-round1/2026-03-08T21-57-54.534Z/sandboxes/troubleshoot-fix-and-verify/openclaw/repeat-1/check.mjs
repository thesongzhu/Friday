import { add } from './calc.js';
if (add(2, 3) !== 5) {
  console.error('FAIL');
  process.exit(1);
}
console.log('PASS');
