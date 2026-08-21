import fs from 'fs';
import path from 'path';
import readline from 'readline';

const envPath = path.resolve('.env');

function updateEnv(key, value) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  const lines = content.split('\n');
  const filtered = lines.filter(line => !line.trim().startsWith(`${key}=`));
  filtered.push(`${key}=${value}`);
  fs.writeFileSync(envPath, filtered.join('\n') + '\n', 'utf8');
}

const args = process.argv.slice(2);

if (args.includes('--firebase')) {
  const jsonPath = args[args.indexOf('--firebase') + 1];
  if (!jsonPath) {
    console.error('Error: Please provide the path to your Firebase service account JSON file.');
    console.error('Example: node src/scripts/set-keys.js --firebase C:\\path\\to\\key.json');
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(path.resolve(jsonPath), 'utf8');
    // Validate JSON
    const parsed = JSON.parse(raw);
    updateEnv('FIREBASE_SERVICE_ACCOUNT', JSON.stringify(parsed));
    console.log('Firebase service account successfully updated in .env');
  } catch (err) {
    console.error('Error reading/parsing Firebase JSON:', err.message);
    process.exit(1);
  }
} else if (args.includes('--gemini')) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.stdoutMuted = true;
  rl.query = "Enter your Gemini API key: ";
  rl.output.write(rl.query);
  
  rl.on('line', (line) => {
    rl.close();
    const key = line.trim();
    if (!key) {
      console.error('\nError: Key cannot be empty.');
      process.exit(1);
    }
    updateEnv('GEMINI_API_KEY', key);
    console.log('\nGemini API key successfully updated in .env');
  });

  rl._writeToOutput = function _writeToOutput(stringToWrite) {
    if (rl.stdoutMuted) {
      if (stringToWrite === rl.query) {
        rl.output.write(stringToWrite);
      } else if (stringToWrite === '\r\n' || stringToWrite === '\n') {
        rl.output.write(stringToWrite);
      } else {
        // Print asterisks for each typed character
        rl.output.write('*');
      }
    } else {
      rl.output.write(stringToWrite);
    }
  };
} else {
  console.log('Usage:');
  console.log('  node src/scripts/set-keys.js --gemini            (to set your Gemini API key)');
  console.log('  node src/scripts/set-keys.js --firebase <path>   (to set your Firebase service account JSON)');
}
