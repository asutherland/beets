'use strict';
// XXX this really wants to go into a proper module idiom

var PUNC_RE = /[-`~@#$%^&*()_=+\[\]{}\\|;:'"",<.>/?]/g;

// see the docs for makeLocaleAndPuncComparator.  This is now used to optimize
// sorting by just computing a sort name for the artist here in the UI.  Note
// that beets already has a concept of having a sort name, but at least since
// this isn't populated in my DB right now, we just do this.
function normalizeName(name) {
  return Diacritics.clean(name).toLowerCase().replace(PUNC_RE, '');
}

/**
 * Create a comparator that's basically localeCompare plus pretending
 * punctuation does not exist.  For consistency, this is basically the same
 * logic we use for filtering artists except that ignores white-space.
 *
 * Note that while we could use localeCompare after our normalization, we just
 * use straight-up comparison after normalizing.
 *
 * Also note that localeCompare now supports an options dict which would let us
 * tell it to ignorePunctuation.  Unfortunately, that's in Firefox 29 and stable
 * Firefox is 28, so we can't really do that yet.
 */
function makeLocaleAndPuncComparator(fieldName) {
  return function(a, b) {
    //return a.get(fieldName).localeCompare(b.get(fieldName));
    var normA = Diacritics.clean(a.get(fieldName)).toLowerCase()
                  .replace(PUNC_RE, '');
    var normB = Diacritics.clean(b.get(fieldName)).toLowerCase()
                  .replace(PUNC_RE, '');
    if (normA < normB) {
      return -1;
    }
    else if (normA > normB) {
      return 1;
    }
    else {
      return 0;
    }
  };
}

var Track = Backbone.Model.extend({
  urlRoot: '/item',
  initialize: function() {
    this.set('normalbumtype', normalizeAlbumType(this.get('albumtype')));
  },
  play: function() {
    $.post('/control/play', { item: this.get('id') });
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
    this.set('normalbum', normalizeName(this.get('album')));
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
  comparator: 'normalbum',
});
var AlbumsWithComputedArtists = Backbone.Collection.extend({
  model: Album,
  comparator: 'normalbum',
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
        artist = new Artist({
          name: artistName,
          normname: normalizeName(artistName)
        });
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

    // invalidate our fancy cached promise if a new album gets added.
    this.albums.on('add', function() {
      this._allTracksPromise = null;
    }.bind(this));
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
      return album.ensureTracks();
    })).then(function() {
      this.albums.forEach(function(album) {
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
  comparator: 'normname',
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
