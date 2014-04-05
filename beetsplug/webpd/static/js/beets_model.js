'use strict';


var Track = Backbone.Model.extend({
  urlRoot: '/item',
  initialize: function() {
    this.set('normalbumtype', normalizeAlbumType(this.get('albumtype')));
  }
});
var Tracks = Backbone.Collection.extend({
  model: Track,
  comparator: 'track',
});

/**
 * Normalize things into a world-view where there are only albums, singles, and
 * compilations.
 */
function normalizeAlbumType(type) {
  switch (type) {
    case 'single':
    case 'remix':
    case 'dj-mix':
      return 'single';

    case 'compilation':
      return 'compilation';

    case 'album':
    case 'ep':
    // If we don't know then assume it's an album
    default:
      return 'album';
  }
}

/**
 * The meta-data about an album with a nested tracks collection glued on.
 *
 * There should only ever be one instance of an Album present in our memory at
 * a time.
 */
var Album = Backbone.Model.extend({
  urlRoot: '/album',
  initialize: function() {
    this.set('normalbumtype', normalizeAlbumType(this.get('albumtype')));
    this.tracks = new Tracks();
    this._trackFetchPromise = null;
  },
  /**
   * Asynchronously populate our list of tracks from the server if not already
   * populated.  This does not have any side-effects on composite collections;
   * use something like Arist.ensureAllTracks() instead.
   */
  ensureTracks: function() {
    if (this._trackFetchPromise) {
      return this._trackFetchPromise;
    }

    this._trackFetchPromise = new Promise(function(resolve, reject) {
      var url = '/album/' + this.get('id') + '/full';
      $.ajax({
        dataType: 'json',
        url: url,
        success: function(data) {
          this.tracks.add(data.items);
          resolve(this);
        }.bind(this),
        error: function(err) {
          reject(err);
        },
      });

    }.bind(this));
    return this._trackFetchPromise;
  }
});
var Albums = Backbone.Collection.extend({
  model: Album,
  comparator: 'album',
});
var AlbumsWithComputedArtists = Backbone.Collection.extend({
  model: Album,
  comparator: 'album',
  initialize: function() {
    // The computed artists collection
    this.artists = new Artists();
    // Convenience manual map from artist name to artist
    this.artistByName = Object.create(null);
    this.on('add', function(album) {
      var artistName = album.get('albumartist');
      var artist;
      if (artistName in this.artistByName) {
        // console.log('reusing artist', artistName);
        artist = this.artistByName[artistName];
      }
      else {
        // console.log('creating artist', artistName);
        artist = new Artist({ name: artistName });
        this.artists.add(artist);
        this.artistByName[artistName] = artist;
      }
      artist.albums.add(album);
    }.bind(this));
    this.on('remove', function(album) {
      var artistName = album.get('albumartist');
      var artist = this.artistByName[artistName];
      artist.albums.remove(album);
      if (artist.albums.length === 0) {
        this.artists.remove(artist);
        delete this.artistByname[artistName];
      }
    }.bind(this));
  }
});

var pendingTrackReqs = 0;

var Artist = Backbone.Model.extend({
  initialize: function() {
    this.albums = new Albums();
    this.allTracks = new Tracks();
    this._allTracksPromise = null;
  },
  /**
   * Trigger the load of all tracks for all owned albums and then update the
   * allTracks composite collection when that is completed.
   *
   * @return {Promise}
   *   A promise resolved with the `allTracks` collection when all the tracks
   *   are loaded and allTracks has been updated.
   */
  ensureAllTracks: function() {
    if (this._allTracksPromise) {
      return this._allTracksPromise;
    }

    // Wait for all the albums to have loaded their tracks, then update our
    // allTracks composite
    // 'this' when that happens.
    this._allTracksPromise = Promise.all(this.albums.map(function(album) {
      console.log('pending', ++pendingTrackReqs);

      return album.ensureTracks();
    })).then(function() {
      this.albums.forEach(function(album) {
        console.log('done', --pendingTrackReqs);
        // adding the same track more than once is a no-op
        this.allTracks.add(album.tracks.models);
      }.bind(this));
      return this.allTracks;
    }.bind(this));
    return this._allTracksPromise;
  }
});
var Artists = Backbone.Collection.extend({
  model: Artist,
  comparator: 'name',
});

var allAlbums = new AlbumsWithComputedArtists();
var allArtists = allAlbums.artists;


////////////////////////////////////////////////////////////////////////////////
// Artists: A derived collection based on allAlbums.


var ALBUM_FETCH_CHUNK_SIZE = 100;
function populateAlbums(highAlbumId) {
  var nextId = 0;

  function getMore() {
    if (nextId >= highAlbumId) {
      done();
      return;
    }

    var lowId = nextId;
    var highId = Math.min(lowId + ALBUM_FETCH_CHUNK_SIZE - 1, highAlbumId);
    nextId = highId + 1;
    var ids = [];
    for (var id = lowId; id <= highId; id++) {
      ids.push(id);
    }
    var url = '/album/' + ids.join(',');
    $.ajax({
      dataType: 'json',
      url: url,
      success: function(data) {
        // if there was only one album in the range, we need to normalize
        if (!data.albums) {
          data = { albums: [data] };
        }
        //console.log('fetched albums:', lowId, '-', highId, 'got',
        //            data.albums.length);
        allAlbums.add(data.albums);
        getMore();
      },
      error: function() {
        //console.log('range was missing albums:', lowId, '-', highId);
        getMore();
      },
    });
  }

  function done() {
    console.log('got all albums through id', highAlbumId);
    if (window.polymerArtistList) {
      window.polymerArtistList.refresh();
    }
  }
  getMore();
}
$.getJSON('/stats', function(stats) {
  populateAlbums(stats.highAlbum);
});
