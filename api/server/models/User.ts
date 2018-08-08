import * as _ from 'lodash';
import * as mongoose from 'mongoose';

import sendEmail from '../aws-ses';
import logger from '../logs';
import { subscribe } from '../mailchimp';
import { generateSlug } from '../utils/slugify';
import getEmailTemplate from './EmailTemplate';
import Invitation from './Invitation';
import Team from './Team';

import { createCustomer, createNewCard, retrieveCard, updateCustomer } from '../stripe';

const mongoSchema = new mongoose.Schema({
  googleId: {
    type: String,
    required: true,
    unique: true,
  },
  googleToken: {
    accessToken: String,
    refreshToken: String,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },

  defaultTeamSlug: {
    type: String,
    default: '',
  },

  isAdmin: {
    type: Boolean,
    default: false,
  },
  displayName: String,
  avatarUrl: String,

  stripeCustomer: {
    id: String,
    object: String,
    created: Number,
    currency: String,
    default_source: String,
    description: String,
  },
  stripeCard: {
    id: String,
    object: String,
    brand: String,
    funding: String,
    country: String,
    last4: String,
    exp_month: Number,
    exp_year: Number,
  },
  hasCardInformation: {
    type: Boolean,
    default: false,
  },
});

export interface IUserDocument extends mongoose.Document {
  googleId: string;
  googleToken: { accessToken: string; refreshToken: string };
  slug: string;
  createdAt: Date;

  email: string;
  isAdmin: boolean;
  displayName: string;
  avatarUrl: string;

  defaultTeamSlug: string;

  hasCardInformation: boolean;
  stripeCustomer: {
    id: string;
    default_source: string;
    created: number;
    object: string;
    description: string;
  };
  stripeCard: {
    id: string;
    object: string;
    brand: string;
    country: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    funding: string;
  };
}

interface IUserModel extends mongoose.Model<IUserDocument> {
  publicFields(): string[];

  updateProfile({
    userId,
    name,
    avatarUrl,
  }: {
    userId: string;
    name: string;
    avatarUrl: string;
  }): Promise<IUserDocument[]>;

  getTeamMembers({ userId, teamId }: { userId: string; teamId: string }): Promise<IUserDocument[]>;

  signInOrSignUp({
    googleId,
    email,
    googleToken,
    displayName,
    avatarUrl,
  }: {
    googleId: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    googleToken: { refreshToken?: string; accessToken?: string };
  }): Promise<IUserDocument>;

  createCustomer({
    userId,
    stripeToken,
  }: {
    userId: string;
    stripeToken: object;
  }): Promise<IUserDocument>;

  createNewCardUpdateCustomer({
    userId,
    stripeToken,
  }: {
    userId: string;
    stripeToken: object;
  }): Promise<IUserDocument>;
}

// mongoSchema.pre('save', function(next) {
//   if (!this.createdAt) this.createdAt = new Date();
//   next();
// });

class UserClass extends mongoose.Model {
  public static async updateProfile({ userId, name, avatarUrl }) {
    // TODO: If avatarUrl is changed and old is uploaded to our S3, delete it from S3

    const user = await this.findById(userId, 'slug displayName');

    const modifier = { displayName: user.displayName, avatarUrl, slug: user.slug };

    if (name !== user.displayName) {
      modifier.displayName = name;
      modifier.slug = await generateSlug(this, name);
    }

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('displayName avatarUrl slug')
      .lean();
  }

  public static async createCustomer({ userId, stripeToken }) {
    const user = await this.findById(userId, 'email');

    const customerObj = await createCustomer({
      token: stripeToken.id,
      teamLeaderEmail: user.email,
      teamLeaderId: userId,
    });

    logger.debug(customerObj.default_source.toString());

    const cardObj = await retrieveCard({
      customerId: customerObj.id,
      cardId: customerObj.default_source.toString(),
    });

    const modifier = { stripeCustomer: customerObj, stripeCard: cardObj, hasCardInformation: true };

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('stripeCustomer stripeCard hasCardInformation')
      .lean();
  }

  public static async createNewCardUpdateCustomer({ userId, stripeToken }) {
    const user = await this.findById(userId, 'stripeCustomer');

    logger.debug('called static method on User');

    const newCardObj = await createNewCard({
      customerId: user.stripeCustomer.id,
      token: stripeToken.id,
    });

    logger.debug(newCardObj.id);

    const updatedCustomerObj = await updateCustomer({
      customerId: user.stripeCustomer.id,
      newCardId: newCardObj.id,
    });

    const modifier = { stripeCustomer: updatedCustomerObj, stripeCard: newCardObj };

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('stripeCard')
      .lean();
  }

  public static async getTeamMembers({ userId, teamId }) {
    const team = await this.checkPermissionAndGetTeam({ userId, teamId });

    return this.find({ _id: { $in: team.memberIds } })
      .select(this.publicFields().join(' '))
      .lean();
  }

  public static async signInOrSignUp({ googleId, email, googleToken, displayName, avatarUrl }) {
    const user = await this.findOne({ googleId })
      .select(this.publicFields().join(' '))
      .lean();

    if (user) {
      if (_.isEmpty(googleToken)) {
        return user;
      }

      const modifier = {};
      if (googleToken.accessToken) {
        modifier['googleToken.accessToken'] = googleToken.accessToken;
      }

      if (googleToken.refreshToken) {
        modifier['googleToken.refreshToken'] = googleToken.refreshToken;
      }

      await this.updateOne({ googleId }, { $set: modifier });

      return user;
    }

    const slug = await generateSlug(this, displayName);

    const newUser = await this.create({
      createdAt: new Date(),
      googleId,
      email,
      googleToken,
      displayName,
      avatarUrl,
      slug,
      defaultTeamSlug: '',
    });

    const hasInvitation = (await Invitation.countDocuments({ email })) > 0;

    const template = await getEmailTemplate('welcome', {
      userName: displayName,
    });

    if (!hasInvitation) {
      try {
        await sendEmail({
          from: `Kelly from async-await.com <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
          to: [email],
          subject: template.subject,
          body: template.message,
        });
      } catch (err) {
        logger.error('Email sending error:', err);
      }
    }

    try {
      await subscribe({
        email,
        listName: 'signups',
      });
    } catch (error) {
      logger.error('Mailchimp error:', error);
    }

    return _.pick(newUser, this.publicFields());
  }

  public static publicFields(): string[] {
    return [
      '_id',
      'id',
      'displayName',
      'email',
      'avatarUrl',
      'slug',
      'isGithubConnected',
      'defaultTeamSlug',
    ];
  }

  public static async checkPermissionAndGetTeam({ userId, teamId }) {
    if (!userId || !teamId) {
      throw new Error('Bad data');
    }

    const team = await Team.findById(teamId)
      .select('memberIds')
      .lean();

    if (!team || team.memberIds.indexOf(userId) === -1) {
      throw new Error('Team not found');
    }

    return team;
  }
}

mongoSchema.loadClass(UserClass);

const User = mongoose.model<IUserDocument, IUserModel>('User', mongoSchema);

export default User;
