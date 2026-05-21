class OAuth2Client {
  constructor(clientId) {
    this.clientId = clientId;
  }

  async verifyIdToken({ idToken, audience }) {
    if (idToken === 'invalid_token' || !idToken) {
      throw new Error('Invalid token');
    }
    return {
      getPayload: () => ({
        sub: 'google-uid-12345',
        email: 'felipe.test@gmail.com',
        name: 'Felipe Test',
        picture: 'https://example.com/profile.jpg',
        email_verified: true,
      }),
    };
  }

  async getToken(code) {
    if (code === 'invalid_code') {
      throw new Error('Invalid code');
    }
    return {
      tokens: {
        access_token: 'mock_access_token',
        refresh_token: 'mock_refresh_token',
        id_token: 'mock_id_token',
        expiracy_date: new Date().getTime() + 3600000,
      },
    };
  }
  setCredentials(tokens) {}
}

module.exports = {
  OAuth2Client,
};
