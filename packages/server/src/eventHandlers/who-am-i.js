const { getUser, createUser } = require('../helpers/db-operations');

exports.whoAmI = async userId => {
  let userData;
  try {
    userData = await getUser(userId);

    // Create a new user in the database if doesn't exist
    if (!userData || !userData.Item) {
      await createUser(userId);
      userData = await getUser(userId);
    }
  } catch (err) {
    console.log(err);
    return null;
  }

  console.warn('userData', userData);

  return userData.Item;
};
