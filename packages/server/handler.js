const { uniqueNamesGenerator, adjectives, colors, animals } = require('unique-names-generator');
const AWS = require('aws-sdk');
const REGION = process.env.REGION || 'us-east-1';
const TABLE_NAME = process.env.TABLE_NAME || '';

AWS.config.update({
  region: REGION,
});

const docClient = new AWS.DynamoDB.DocumentClient();

const gameSettings = [
  { id: '001', name: 'Italy', tiles: 100, board: [10, 10] },
  { id: '002', name: 'Food', tiles: 100, board: [10, 10] },
];

const randomNameConfig = {
  dictionaries: [adjectives, colors, animals],
  length: 3,
  separator: '_',
  style: 'lowerCase',
};

const tilesBase = {
  id: 0,
  ref: '01',
  status: 'hidden',
};

const shuffle = input => {
  return input.sort(() => Math.random() - 0.5);
};

const getRef = index => {
  const ref = Math.floor((index + 2) / 2);
  return ref < 10 ? `00${ref}` : `0${ref}`;
};

const newBoard = (rows, columns) => {
  const items = rows * columns;

  const tiles = new Array(items).fill('').reduce(
    (acc, _, currIndex) => [
      ...acc,
      {
        ...tilesBase,
        id: currIndex,
        ref: getRef(currIndex),
      },
    ],
    []
  );

  return shuffle(tiles);
};

const doesItemExist = data => {
  if (data && data.Items && data.Count && data.Count > 0 && data.Items.length && data.Items[0]) {
    return data.Items[0];
  }

  return undefined;
};

const findItem = async (tableName, itemId) => {
  const params = {
    TableName: tableName,
    KeyConditionExpression: '#id = :id',
    ExpressionAttributeNames: {
      '#id': 'id',
    },
    ExpressionAttributeValues: {
      ':id': itemId,
    },
  };

  return docClient.query(params).promise();
};

const generateUniqueName = async tableName => {
  const randomName = async (fileName, iteration = 1) => {
    if (iteration > 3) {
      return null;
    }

    let itemData;
    try {
      itemData = await findItem(tableName, fileName);
    } catch (err) {
      console.log(err);
      return null;
    }

    if (doesItemExist(itemData)) {
      const newFileName = uniqueNamesGenerator(randomNameConfig);
      return randomName(newFileName, iteration + 1);
    }
    return fileName;
  };

  return randomName(uniqueNamesGenerator(randomNameConfig));
};

exports.graphqlHandler = async (event, context, callback) => {
  const { field, owner, input } = event;
  console.log('event', event);

  switch (field) {
    case 'createGame': {
      const { name, size, players, template } = input;
      const gameTemplate = gameSettings.find(settings => settings.id === template);

      const gamePlayers = players
        .filter(player => player.active)
        .map((player, index) => ({
          id: index + 1,
          name: player.name,
          moves: 0,
          pairs: 0,
        }));
      const randomName = await generateUniqueName(TABLE_NAME);
      const createdAt = new Date().toISOString();
      const board = {
        gridX: gameTemplate.board[0],
        gridY: gameTemplate.board[1],
      };
      const tiles = newBoard(board.gridX, board.gridY);
      const values = {
        __typename: 'Game',
        createdAt,
        moves: 0,
        teams: size,
        players: gamePlayers,
        playerTurn: {
          ...gamePlayers[0],
          turn: 0,
        },
        board,
        tiles,
        template,
        name,
        owner,
      };

      if (randomName) {
        callback(null, { id: randomName, values });
      } else {
        callback(null, { error: 'Cannot find an available game name' });
      }

      break;
    }

    case 'claimPlayer': {
      const { input, userId } = event;
      const { gameId, playerId } = input;
      const gameData = await findItem(TABLE_NAME, gameId);
      const gameExists = doesItemExist(gameData);

      if (!gameExists) {
        callback(null, { error: `Game ${gameId} does not exist` });
      }

      const gameDataItem = gameData.Items[0];
      const players = (gameDataItem && gameDataItem.players) || [];
      const teams = gameDataItem.teams;

      const playersUpdated = players.map(player => {
        if (`${player.id}` === `${playerId}`) {
          return {
            ...player,
            userId,
          };
        }
        return player;
      });

      const assignedPlayers = playersUpdated.filter(player => player.userId);
      let playerTurnUpdated = gameDataItem.playerTurn;

      if (assignedPlayers.length === teams) {
        playerTurnUpdated = playersUpdated[0];
      }

      const values = {
        players: playersUpdated,
        playerTurn: {
          ...playerTurnUpdated,
          turn: 0,
        },
      };

      callback(null, { id: gameId, values });

      break;
    }

    case 'checkoutTile': {
      const { input, userId } = event;
      const { gameId, tileId } = input;
      const gameData = await findItem(TABLE_NAME, gameId);
      const gameExists = doesItemExist(gameData);

      if (!gameExists) {
        callback(null, { error: `Game ${gameId} does not exist` });
      }

      const gameDataItem = gameData.Items[0];
      const tiles = gameDataItem.tiles;
      const playerTurn = gameDataItem.playerTurn;
      const moves = gameDataItem.moves;
      const players = gameDataItem.players;
      let playersUpdated = players;

      if (userId !== playerTurn.userId) {
        callback(null, { error: `Invalid move` });
      }

      const currTile = tiles.find(tile => `${tile.id}` === `${tileId}`);
      const shouldUpdate = currTile.status === 'hidden';
      const isWin = playerTurn.turn === 2 && `${currTile.ref}` === playerTurn.tileRef;

      if (!shouldUpdate) {
        // Only hidden tile can be checked out. if already in show state. don't take any action
        callback(null, { id: gameId, values: {} });
      }

      if (!playerTurn.turn) {
        // Avoid player checking out more than 2 cards per turn
        callback(null, { id: gameId, values: {} });
      }

      let tilesUpdated = tiles.map(tile => {
        if (`${tile.id}` === `${tileId}` && !isWin) {
          return {
            ...tile,
            status: 'show',
          };
        }
        return tile;
      });

      const currPlayer = players.findIndex(player => player.id === playerTurn.id);
      const nextPlayer = currPlayer < players.length - 1 ? players[currPlayer + 1] : players[0];

      const updatePlayerTurn = () => {
        if (playerTurn.turn > 1 && !isWin) {
          return {
            ...nextPlayer,
            turn: 0,
          };
        } else if (playerTurn.turn > 1 && isWin) {
          return {
            ...playerTurn,
            turn: 1,
          };
        }

        return {
          ...playerTurn,
          turn: (playerTurn.turn || 0) + 1,
          tileRef: `${currTile.ref}`,
        };
      };

      const playerTurnUpdated = updatePlayerTurn();

      if (isWin) {
        tilesUpdated = tiles.map(tile => {
          if (`${tile.ref}` === `${currTile.ref}`) {
            return {
              ...tile,
              status: 'taken',
            };
          }
          return tile;
        });

        playersUpdated = players.map(player => {
          if (player.userId === userId) {
            return {
              ...player,
              score: (player.score || 0) + 1,
            };
          }

          return player;
        });
      }

      const values = {
        moves: moves + 1,
        tiles: tilesUpdated,
        playerTurn: playerTurnUpdated,
        players: playersUpdated,
      };

      callback(null, { id: gameId, values });

      break;
    }

    case 'playTurn': {
      const { input } = event;
      const { gameId } = input;
      const gameData = await findItem(TABLE_NAME, gameId);
      const gameExists = doesItemExist(gameData);

      if (!gameExists) {
        callback(null, { error: `Game ${gameId} does not exist` });
      }

      const gameDataItem = gameData.Items[0];
      const tiles = gameDataItem.tiles.map(tile => ({
        ...tile,
        status: tile.status === 'taken' ? 'taken' : 'hidden',
      }));

      const playerTurnUpdated = {
        ...gameDataItem.playerTurn,
        turn: 1,
      };

      const values = {
        playerTurn: playerTurnUpdated,
        tiles,
      };

      console.log('values', values);
      callback(null, { id: gameId, values });

      break;
    }

    case 'settings': {
      callback(null, gameSettings);
      break;
    }

    default: {
      callback(null, { error: `Unknown field, unable to resolve ${event.field}` });
      break;
    }
  }
};
