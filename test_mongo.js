const mongoose = require('mongoose');

const passwords = [
  'yKwKra4yBte1OgZT',
  'yKwKra4yBte10gZT',
  'yKwKra4yBtelOgZT',
  'yKwKra4yBtel0gZT',
  'yKwKra4yBteI0gZT',
  'yKwKra4yBteIOgZT',
];

async function test() {
  for (const p of passwords) {
    try {
      const uri = `mongodb+srv://antigravtiy4_db_user:${p}@cluster0.tzyuban.mongodb.net/test?retryWrites=true&w=majority&appName=Cluster0`;
      await mongoose.connect(uri);
      console.log('SUCCESS with password:', p);
      await mongoose.disconnect();
      return;
    } catch (e) {
      console.log('Failed:', p);
    }
  }
}
test();
